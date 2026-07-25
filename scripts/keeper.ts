#!/usr/bin/env tsx
/**
 * keeper.ts — Autonomous keeper bot for FlowPay recurring billing
 *
 * Continuously invokes `batch_charge()` on the deployed FlowPay contract,
 * paging through all active subscriptions on a configurable interval.
 *
 * Architecture
 * ────────────
 * Each charge cycle iterates subscriber pages (offset 0, PAGE_SIZE, 2×PAGE_SIZE …)
 * until a page returns fewer results than PAGE_SIZE, signalling the end of the
 * subscriber index. Failed pages are retried up to MAX_RETRIES times with
 * exponential back-off before being skipped and logged.
 *
 * Usage
 * ─────
 *   CONTRACT_ID=C... KEEPER_SECRET=S... tsx keeper.ts
 *
 * Environment variables
 * ─────────────────────
 *   CONTRACT_ID          Required. Deployed FlowPay contract ID.
 *   KEEPER_SECRET        Required. Stellar secret key (S...) funding keeper txns.
 *   RPC_URL              Soroban RPC endpoint (default: testnet).
 *   NETWORK_PASSPHRASE   Stellar network passphrase (default: testnet).
 *   CHARGE_INTERVAL_MS   Milliseconds between full charge cycles (default: 3600000 = 1 h).
 *   PAGE_SIZE            Subscriptions per batch_charge call (default: 100, max: 100).
 *   MAX_RETRIES          Per-page retry attempts before skipping (default: 3).
 *   LOG_LEVEL            debug | info | warn | error (default: info).
 *
 * Exit codes
 * ──────────
 *   0 — graceful shutdown (SIGINT / SIGTERM)
 *   1 — fatal configuration error
 */

import {
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { Server, assembleTransaction } from "@stellar/stellar-sdk/rpc";

// ── Configuration ─────────────────────────────────────────────────────────────

const CONTRACT_ID = process.env.CONTRACT_ID ?? "";
const KEEPER_SECRET = process.env.KEEPER_SECRET ?? "";
const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = (process.env.NETWORK_PASSPHRASE ??
  Networks.TESTNET) as string;
const CHARGE_INTERVAL_MS = parseInt(
  process.env.CHARGE_INTERVAL_MS ?? "3600000",
  10,
);
const PAGE_SIZE = Math.min(parseInt(process.env.PAGE_SIZE ?? "100", 10), 100);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES ?? "3", 10);
const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info") as
  "debug" | "info" | "warn" | "error";

// ── Startup validation ────────────────────────────────────────────────────────

if (!CONTRACT_ID) {
  console.error("FATAL: CONTRACT_ID environment variable is required.");
  process.exit(1);
}
if (!KEEPER_SECRET) {
  console.error("FATAL: KEEPER_SECRET environment variable is required.");
  process.exit(1);
}

let keeperKeypair: Keypair;
try {
  keeperKeypair = Keypair.fromSecret(KEEPER_SECRET);
} catch {
  console.error("FATAL: KEEPER_SECRET is not a valid Stellar secret key.");
  process.exit(1);
}

// ── Logging ───────────────────────────────────────────────────────────────────

const LEVEL_ORDER: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const activeLevel = LEVEL_ORDER[LOG_LEVEL] ?? 1;

function log(
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  meta?: Record<string, unknown>,
): void {
  if ((LEVEL_ORDER[level] ?? 0) < activeLevel) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

// ── RPC client ────────────────────────────────────────────────────────────────

const server = new Server(RPC_URL);
const contract = new Contract(CONTRACT_ID);

// ── Charge result types ───────────────────────────────────────────────────────

interface PageSummary {
  page: number;
  offset: number;
  charged: number;
  skipped: number;
  error: string | null;
}

interface CycleSummary {
  cycle: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  total_charged: number;
  total_skipped: number;
  pages_processed: number;
  pages_failed: number;
}

// ── Batch charge execution ────────────────────────────────────────────────────

/**
 * Parse the `Vec<ChargeResult>` returned by `batch_charge`.
 * ChargeResult is an enum: Charged | Skipped(reason) | NoSubscription.
 * We only need the counts here.
 */
function parseChargeResults(retval: xdr.ScVal): {
  charged: number;
  skipped: number;
} {
  let charged = 0;
  let skipped = 0;

  const vec = retval.vec();
  if (!vec) return { charged, skipped };

  for (const item of vec) {
    try {
      const name = item.switch().name;
      // scvVec wraps enum variants; check the inner sym name
      if (name === "scvVec") {
        const inner = item.vec();
        const variant = inner?.[0]?.sym()?.toString() ?? "";
        if (variant === "Charged") charged++;
        else skipped++;
      } else if (name === "scvMap") {
        // Some SDK versions wrap enum as a map
        const key = item.map()?.[0]?.key()?.sym()?.toString() ?? "";
        if (key === "Charged") charged++;
        else skipped++;
      } else {
        // Unrecognised shape — count as skipped
        skipped++;
      }
    } catch {
      skipped++;
    }
  }

  return { charged, skipped };
}

/**
 * Submit one `batch_charge(offset, limit)` transaction and return the result.
 * Throws on RPC / submission error so the caller can retry.
 */
async function batchChargePage(
  offset: number,
  limit: number,
): Promise<{ charged: number; skipped: number }> {
  const account = await server.getAccount(keeperKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "batch_charge",
        nativeToScVal(offset, { type: "u32" }),
        nativeToScVal(limit, { type: "u32" }),
      ),
    )
    .setTimeout(60)
    .build();

  // Simulate to populate the Soroban footprint.
  const simResult = await server.simulateTransaction(tx);
  if ("error" in simResult) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  // Assemble and sign.
  const assembled = assembleTransaction(tx, simResult).build();
  assembled.sign(keeperKeypair);

  // Submit and wait for confirmation.
  const sendResult = await server.sendTransaction(assembled);
  if (sendResult.status === "ERROR") {
    throw new Error(`Transaction rejected: ${JSON.stringify(sendResult)}`);
  }

  // Poll for final status.
  const hash = sendResult.hash;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const status = await server.getTransaction(hash);
    if (status.status === "SUCCESS") {
      const retval = (status as { returnValue?: xdr.ScVal }).returnValue;
      if (!retval) return { charged: 0, skipped: 0 };
      return parseChargeResults(retval);
    }
    if (status.status === "FAILED") {
      throw new Error(`Transaction failed on-chain: ${hash}`);
    }
    // status === "NOT_FOUND" means still pending — keep polling
  }

  throw new Error(`Transaction ${hash} not confirmed within 30 s`);
}

// ── Retry with exponential back-off ──────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt `batchChargePage` up to `MAX_RETRIES` times with exponential back-off.
 * Returns a PageSummary. On exhausted retries, `error` field is set.
 */
async function chargePageWithRetry(
  page: number,
  offset: number,
): Promise<PageSummary> {
  let lastError: string = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { charged, skipped } = await batchChargePage(offset, PAGE_SIZE);
      return { page, offset, charged, skipped, error: null };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const backoff = Math.min(1000 * 2 ** (attempt - 1), 30_000);
      log("warn", `Page ${page} attempt ${attempt}/${MAX_RETRIES} failed`, {
        offset,
        error: lastError,
        retry_in_ms: backoff,
      });
      if (attempt < MAX_RETRIES) await sleep(backoff);
    }
  }

  return { page, offset, charged: 0, skipped: 0, error: lastError };
}

// ── Full charge cycle ─────────────────────────────────────────────────────────

let cycleCount = 0;

async function runChargeCycle(): Promise<CycleSummary> {
  cycleCount++;
  const cycleStart = Date.now();
  const startedAt = new Date(cycleStart).toISOString();

  log("info", "Charge cycle starting", { cycle: cycleCount });

  let totalCharged = 0;
  let totalSkipped = 0;
  let pagesProcessed = 0;
  let pagesFailed = 0;

  let offset = 0;
  let page = 0;

  while (true) {
    const summary = await chargePageWithRetry(page, offset);
    pagesProcessed++;

    if (summary.error) {
      pagesFailed++;
      log("error", "Page failed after all retries — skipping", {
        cycle: cycleCount,
        page,
        offset,
        error: summary.error,
      });
    } else {
      totalCharged += summary.charged;
      totalSkipped += summary.skipped;
      log("debug", "Page processed", {
        cycle: cycleCount,
        page,
        offset,
        charged: summary.charged,
        skipped: summary.skipped,
      });
    }

    // End-of-list detection: if the page returned fewer results than PAGE_SIZE
    // (including 0) we have consumed all subscribers.
    const pageTotal = summary.charged + summary.skipped;
    if (pageTotal < PAGE_SIZE) {
      log("debug", "Last page reached", {
        cycle: cycleCount,
        page,
        page_total: pageTotal,
      });
      break;
    }

    offset += PAGE_SIZE;
    page++;
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - cycleStart;

  const cycleSummary: CycleSummary = {
    cycle: cycleCount,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    total_charged: totalCharged,
    total_skipped: totalSkipped,
    pages_processed: pagesProcessed,
    pages_failed: pagesFailed,
  };

  log(
    "info",
    "Charge cycle complete",
    cycleSummary as unknown as Record<string, unknown>,
  );
  return cycleSummary;
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("info", "FlowPay Keeper starting", {
    contract: CONTRACT_ID,
    keeper: keeperKeypair.publicKey(),
    rpc: RPC_URL,
    charge_interval_ms: CHARGE_INTERVAL_MS,
    page_size: PAGE_SIZE,
    max_retries: MAX_RETRIES,
  });

  let shutdown = false;
  const onSignal = (): void => {
    log(
      "info",
      "Shutdown signal received — finishing current cycle then exiting.",
    );
    shutdown = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  while (!shutdown) {
    try {
      await runChargeCycle();
    } catch (err) {
      // Unexpected error in the cycle loop itself — log and continue.
      log("error", "Unexpected error in charge cycle", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!shutdown) {
      log("info", `Sleeping ${CHARGE_INTERVAL_MS} ms until next cycle.`);
      await sleep(CHARGE_INTERVAL_MS);
    }
  }

  log("info", "Keeper stopped gracefully.");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "Fatal unhandled error",
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
