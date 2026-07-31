#!/usr/bin/env tsx
/**
 * keeper.ts — PayFlow Keeper Bot
 *
 * Processes recurring payments by calling batch_charge() on a regular interval.
 * Uses buildOptimizedBatches() so only ready subscribers are charged, ordered by
 * grace urgency and overdue age.
 * Supports dry-run mode via DRY_RUN=true env var for simulation without state changes.
 *
 * Usage:
 *   CONTRACT_ID=... KEEPER_PUBLIC_KEY=... tsx keeper.ts
 *   CONTRACT_ID=... KEEPER_PUBLIC_KEY=... KEEPER_SECRET=... tsx keeper.ts
 *   CONTRACT_ID=... DRY_RUN=true KEEPER_PUBLIC_KEY=... tsx keeper.ts --once
 *
 * Environment Variables:
 *   CONTRACT_ID           Required. Deployed FlowPay contract ID.
 *   KEEPER_PUBLIC_KEY     Required. Source account public key (must be funded on network).
 *   KEEPER_SECRET         Required in live mode. Secret key to sign transactions.
 *   DRY_RUN               Set to "true" to run in dry-run simulation mode.
 *   RPC_URL               Optional. Soroban RPC endpoint (default: testnet).
 *   NETWORK_PASSPHRASE    Optional. Network passphrase (default: Testnet).
 *   BATCH_SIZE            Optional. Subscribers per page (default: 50, max: 50).
 *   INTERVAL_SECONDS      Optional. Loop interval (default: 3600).
 *
 * Flags:
 *   --once      Run a single cycle and exit.
 *   --help, -h  Show this help message.
 *
 * Caveats:
 *   - Dry-run simulation results may differ from actual charges due to
 *     allowance changes, contract pause state, or timing between simulation
 *     and submission.
 *   - Unlike real batch_charge, get_batch_charge_estimate does not check
 *     contract pause state or token allowances — it only checks subscription
 *     state, interval, and grace period.
 */

import { Server } from "@stellar/stellar-sdk/rpc";
import { buildOptimizedBatches } from "./batch-optimizer";
import {
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  Address,
  xdr,
} from "@stellar/stellar-sdk";

// ── Configuration ────────────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL || "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.CONTRACT_ID || "";
const NETWORK_PASSPHRASE = (process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET) as string;
const DRY_RUN = process.env.DRY_RUN === "true";
const KEEPER_PUBLIC_KEY = process.env.KEEPER_PUBLIC_KEY || "";
const KEEPER_SECRET = process.env.KEEPER_SECRET || "";
const BATCH_SIZE = Math.min(Math.max(Number(process.env.BATCH_SIZE) || 50, 1), 50);
const INTERVAL_SECONDS = Math.max(Number(process.env.INTERVAL_SECONDS) || 3600, 1);

const server = new Server(RPC_URL);

// ── Validation ───────────────────────────────────────────────────────────────

function validateEnv(): void {
  const errors: string[] = [];
  if (!CONTRACT_ID) errors.push("CONTRACT_ID is required");
  if (!KEEPER_PUBLIC_KEY) errors.push("KEEPER_PUBLIC_KEY is required");
  if (!DRY_RUN && !KEEPER_SECRET) errors.push("KEEPER_SECRET is required in live mode (or set DRY_RUN=true)");

  if (errors.length > 0) {
    console.error("Error: Missing required environment variables:");
    for (const err of errors) console.error(`  - ${err}`);
    console.error("\nUsage: CONTRACT_ID=... KEEPER_PUBLIC_KEY=... tsx keeper.ts [--once]");
    console.error("   or: CONTRACT_ID=... DRY_RUN=true KEEPER_PUBLIC_KEY=... tsx keeper.ts --once\n");
    process.exit(1);
  }
}

function showHelp(): void {
  console.log(`
PayFlow Keeper Bot

Usage:
  CONTRACT_ID=... KEEPER_PUBLIC_KEY=... tsx keeper.ts [options]
  CONTRACT_ID=... DRY_RUN=true KEEPER_PUBLIC_KEY=... tsx keeper.ts [options]

Options:
  --once      Run a single charge cycle and exit.
  --help, -h  Show this help message.

Environment Variables:
  CONTRACT_ID           Required. Deployed FlowPay contract ID.
  KEEPER_PUBLIC_KEY     Required. Source account public key (must be funded on the network).
  KEEPER_SECRET         Required for live mode. Secret key to sign transactions.
  DRY_RUN               Set to "true" for dry-run simulation mode (no transactions submitted).
  RPC_URL               Optional. Soroban RPC endpoint (default: testnet).
  NETWORK_PASSPHRASE    Optional. Network passphrase (default: Testnet).
  BATCH_SIZE            Optional. Subscribers per page (default: 50, max: 50).
  INTERVAL_SECONDS      Optional. Seconds between cycles (default: 3600).

Caveats:
  Dry-run results may differ from actual charges — allowance changes, contract
  pause state, or timing between simulation and submission can all cause
  discrepancies. The get_batch_charge_estimate function used in dry-run mode
  does not check token allowances or contract pause state.
  `);
  process.exit(0);
}

// ── SDK Helpers ──────────────────────────────────────────────────────────────

function addressVal(addr: string): xdr.ScVal {
  return nativeToScVal(Address.fromString(addr), { type: "address" });
}

function stroopsToXlm(stroops: bigint | string): string {
  const value = typeof stroops === "bigint" ? Number(stroops) : Number(stroops);
  return (value / 10_000_000).toFixed(7);
}

function log(dryRun: boolean, message: string): void {
  const prefix = dryRun ? "[DRY-RUN]" : "[LIVE]";
  console.log(`${prefix} ${message}`);
}

/**
 * Decode a Vec<ChargeResult> or Vec<ChargeSimResult> from an ScVal return value.
 * Each enum variant is encoded as a ScVal symbol.
 */
function decodeEnumVec(retval: xdr.ScVal): string[] {
  const vec =
    typeof (retval as any).vec === "function"
      ? ((retval as any).vec() as xdr.ScVal[])
      : ((retval as any)._value?.vec as xdr.ScVal[] | undefined);

  if (!Array.isArray(vec)) return [];

  return vec.map((item: any) => {
    if (item.switch?.()?.name === "scvSymbol") {
      return item.sym().toString();
    }
    return String(item);
  });
}

// ── Contract Reads ───────────────────────────────────────────────────────────

async function getSubscriberCount(): Promise<number> {
  const contract = new Contract(CONTRACT_ID);
  const account = await server.getAccount(KEEPER_PUBLIC_KEY);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("get_subscriber_count"))
    .setTimeout(30)
    .build();

  const result = await server.simulateTransaction(tx);
  if ("error" in result) throw new Error(result.error);

  const retval = (result as { result?: { retval?: xdr.ScVal } }).result?.retval;
  if (!retval) return 0;

  return Number(retval.u64());
}

async function getSubscriberPage(offset: number, limit: number): Promise<string[]> {
  const contract = new Contract(CONTRACT_ID);
  const account = await server.getAccount(KEEPER_PUBLIC_KEY);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "get_subscriber_page",
        nativeToScVal(offset, { type: "u64" }),
        nativeToScVal(limit, { type: "u32" })
      )
    )
    .setTimeout(30)
    .build();

  const result = await server.simulateTransaction(tx);
  if ("error" in result) throw new Error(result.error);

  const retval = (result as { result?: { retval?: xdr.ScVal } }).result?.retval;
  if (!retval) return [];

  const vec =
    typeof (retval as any).vec === "function"
      ? ((retval as any).vec() as xdr.ScVal[])
      : ((retval as any)._value?.vec as xdr.ScVal[] | undefined);

  if (!Array.isArray(vec)) return [];

  return vec.map((item: xdr.ScVal) => Address.fromScVal(item).toString());
}

async function getSubscriptionAmount(user: string): Promise<bigint | null> {
  try {
    const contract = new Contract(CONTRACT_ID);
    const account = await server.getAccount(user).catch(() => null);
    if (!account) return null;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call("get_subscription", addressVal(user)))
      .setTimeout(30)
      .build();

    const result = await server.simulateTransaction(tx);
    if ("error" in result) return null;

    const retval = (result as { result?: { retval?: xdr.ScVal } }).result?.retval;
    if (!retval || retval.switch().name === "scvVoid") return null;

    for (const entry of retval.map() ?? []) {
      const key = entry.key().sym().toString();
      const val = entry.val();
      if (key === "amount") {
        return BigInt(val.i128().toString());
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check whether the contract is paused.
 * In dry-run mode, the estimate function doesn't check pause state,
 * so we surface it separately.
 */
async function isContractPaused(): Promise<boolean> {
  try {
    const contract = new Contract(CONTRACT_ID);
    const account = await server.getAccount(KEEPER_PUBLIC_KEY);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call("is_contract_paused"))
      .setTimeout(30)
      .build();

    const result = await server.simulateTransaction(tx);
    if ("error" in result) return false;

    const retval = (result as { result?: { retval?: xdr.ScVal } }).result?.retval;
    return retval?.b() ?? false;
  } catch {
    return false;
  }
}

// ── Batch Charge Simulation (Dry-Run) ────────────────────────────────────────

interface DryRunPageResult {
  checked: number;
  wouldCharge: number;
  totalVolume: bigint;
  skipCounts: Record<string, number>;
  errors: string[];
}

/**
 * Simulate a batch charge using get_batch_charge_estimate.
 * No transaction is submitted — no on-chain state changes.
 */
async function simulateBatchCharge(users: string[]): Promise<{
  results: string[];
  amounts: bigint[];
}> {
  const contract = new Contract(CONTRACT_ID);
  const account = await server.getAccount(KEEPER_PUBLIC_KEY);

  const usersVec = xdr.ScVal.scvVec(users.map((u) => addressVal(u)));
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("get_batch_charge_estimate", usersVec))
    .setTimeout(30)
    .build();

  const result = await server.simulateTransaction(tx);
  if ("error" in result) throw new Error(result.error);

  const retval = (result as { result?: { retval?: xdr.ScVal } }).result?.retval;
  if (!retval) return { results: users.map(() => "Unknown"), amounts: [] };

  const variants = decodeEnumVec(retval);

  // Fetch amounts for users that would be charged (for volume estimation)
  const amounts: bigint[] = [];
  for (let i = 0; i < Math.min(variants.length, users.length); i++) {
    if (variants[i] === "Charged") {
      const amt = await getSubscriptionAmount(users[i]);
      amounts.push(amt ?? 0n);
    }
  }

  return { results: variants, amounts };
}

// ── Live Batch Charge ────────────────────────────────────────────────────────

interface LivePageResult {
  charged: number;
  totalVolume: bigint;
  skipCounts: Record<string, number>;
  txHash?: string;
  errors: string[];
}

/**
 * Build, sign, and submit a real batch_charge transaction.
 * Returns the preview results from simulation (before submission).
 */
async function submitBatchCharge(users: string[]): Promise<{
  results: string[];
  amounts: bigint[];
  txHash: string;
}> {
  const contract = new Contract(CONTRACT_ID);
  const account = await server.getAccount(KEEPER_PUBLIC_KEY);

  const usersVec = xdr.ScVal.scvVec(users.map((u) => addressVal(u)));
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("batch_charge", usersVec))
    .setTimeout(30)
    .build();

  // Simulate to get fee estimation and preview results
  const simResult = await server.simulateTransaction(tx);
  if ("error" in simResult) throw new Error(simResult.error);

  const retval = (simResult as { result?: { retval?: xdr.ScVal } }).result?.retval;
  const previewResults = retval ? decodeEnumVec(retval) : users.map(() => "Unknown");

  // Pre-fetch amounts for charging users (preview)
  const amounts: bigint[] = [];
  for (let i = 0; i < Math.min(previewResults.length, users.length); i++) {
    if (previewResults[i] === "Charged") {
      const amt = await getSubscriptionAmount(users[i]);
      amounts.push(amt ?? 0n);
    }
  }

  // Assemble transaction with simulation results
  const { assembleTransaction } = await import("@stellar/stellar-sdk/rpc");
  const prepared = assembleTransaction(tx, simResult) as any;

  // Sign with keeper secret
  const keypair = Keypair.fromSecret(KEEPER_SECRET);
  prepared.sign(keypair);

  // Submit
  const sendResult = await server.sendTransaction(prepared);
  if (sendResult.status === "ERROR") {
    const errObj = sendResult.errorResult as unknown as { code?: { toString(): string } };
    const code = errObj?.code?.toString() ?? "unknown";
    throw new Error(`Transaction failed (${code})`);
  }

  const txHash = sendResult.hash;

  // Wait for confirmation
  const TIMEOUT_MS = 60_000;
  const POLL_MS = 1_000;
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const txResult = await server.getTransaction(txHash);
    if (txResult.status === "SUCCESS") break;
    if (txResult.status === "FAILED") {
      throw new Error(`Transaction ${txHash} failed on chain`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  return { results: previewResults, amounts, txHash };
}

// ── Page Processing ──────────────────────────────────────────────────────────

async function processPageDryRun(users: string[], pageOffset: number): Promise<DryRunPageResult> {
  const result: DryRunPageResult = {
    checked: users.length,
    wouldCharge: 0,
    totalVolume: 0n,
    skipCounts: {},
    errors: [],
  };

  if (users.length === 0) return result;

  const { results, amounts } = await simulateBatchCharge(users);

  let amountIdx = 0;
  for (let i = 0; i < results.length; i++) {
    const variant = results[i];
    if (variant === "Charged") {
      result.wouldCharge++;
      const amt = amountIdx < amounts.length ? amounts[amountIdx] : 0n;
      result.totalVolume += amt;
      amountIdx++;
    } else {
      result.skipCounts[variant] = (result.skipCounts[variant] || 0) + 1;
    }
  }

  return result;
}

async function processPageLive(users: string[], pageOffset: number): Promise<LivePageResult> {
  const result: LivePageResult = {
    charged: 0,
    totalVolume: 0n,
    skipCounts: {},
    errors: [],
  };

  if (users.length === 0) return result;

  try {
    const { results, amounts, txHash } = await submitBatchCharge(users);
    result.txHash = txHash;

    let amountIdx = 0;
    for (let i = 0; i < results.length; i++) {
      const variant = results[i];
      if (variant === "Charged") {
        result.charged++;
        const amt = amountIdx < amounts.length ? amounts[amountIdx] : 0n;
        result.totalVolume += amt;
        amountIdx++;
      } else {
        result.skipCounts[variant] = (result.skipCounts[variant] || 0) + 1;
      }
    }
  } catch (err) {
    result.errors.push(`Page ${pageOffset}: ${err}`);
  }

  return result;
}

// ── Cycle ────────────────────────────────────────────────────────────────────

interface CycleReport {
  totalChecked: number;
  totalCharged: number;
  totalVolume: bigint;
  totalSkips: Record<string, number>;
  errors: string[];
  txHashes: string[];
}

async function runCycle(): Promise<CycleReport> {
  const isDryRun = DRY_RUN;
  const report: CycleReport = {
    totalChecked: 0,
    totalCharged: 0,
    totalVolume: 0n,
    totalSkips: {},
    errors: [],
    txHashes: [],
  };

  const paused = await isContractPaused();
  if (paused) {
    log(isDryRun, "Contract is PAUSED — skipping charge cycle");
    return report;
  }

  // Ensure optimizer sees the same contract/RPC configuration as this keeper.
  process.env.CONTRACT_ID = CONTRACT_ID;
  process.env.RPC_URL = RPC_URL;
  process.env.NETWORK_PASSPHRASE = NETWORK_PASSPHRASE;

  const optimized = await buildOptimizedBatches();
  report.totalChecked = optimized.ready_count + optimized.deferred_count;

  if (optimized.batches.length === 0) {
    log(
      isDryRun,
      `No ready subscribers (ready=${optimized.ready_count} deferred=${optimized.deferred_count})`
    );
    return report;
  }

  log(
    isDryRun,
    `Optimizer selected ${optimized.ready_count} ready user(s) in ${optimized.batches.length} batch(es); deferred=${optimized.deferred_count}`
  );

  for (const batch of optimized.batches) {
    const users = batch.users;
    const offset = batch.batch;

    if (isDryRun) {
      const pageResult = await processPageDryRun(users, offset);
      report.totalCharged += pageResult.wouldCharge;
      report.totalVolume += pageResult.totalVolume;
      report.errors.push(...pageResult.errors);

      const skipDetails = Object.entries(pageResult.skipCounts)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" | ");

      log(
        true,
        `Batch ${offset}: checked=${pageResult.checked} wouldCharge=${pageResult.wouldCharge} volume=${stroopsToXlm(pageResult.totalVolume)} XLM`
      );
      if (skipDetails) log(true, `  ${skipDetails}`);
    } else {
      const pageResult = await processPageLive(users, offset);
      report.totalCharged += pageResult.charged;
      report.totalVolume += pageResult.totalVolume;

      for (const [k, v] of Object.entries(pageResult.skipCounts)) {
        report.totalSkips[k] = (report.totalSkips[k] || 0) + v;
      }
      report.errors.push(...pageResult.errors);
      if (pageResult.txHash) report.txHashes.push(pageResult.txHash);

      const skipDetails = Object.entries(pageResult.skipCounts)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" | ");

      log(
        false,
        `Batch ${offset}: charged=${pageResult.charged} volume=${stroopsToXlm(pageResult.totalVolume)} XLM${pageResult.txHash ? ` tx=${pageResult.txHash}` : ""}`
      );
      if (skipDetails) log(false, `  ${skipDetails}`);
    }
  }

  const skipDetails = Object.entries(report.totalSkips)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" | ");

  const summary = isDryRun
    ? `Cycle complete: checked=${report.totalChecked} wouldCharge=${report.totalCharged} totalVolume=${stroopsToXlm(report.totalVolume)} XLM`
    : `Cycle complete: charged=${report.totalCharged} totalVolume=${stroopsToXlm(report.totalVolume)} XLM${skipDetails ? ` | ${skipDetails}` : ""}`;

  log(isDryRun, summary);

  if (report.errors.length > 0) {
    for (const err of report.errors) log(isDryRun, `Error: ${err}`);
  }

  return report;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") showHelp();
  }

  const once = argv.includes("--once");

  validateEnv();

  if (DRY_RUN) {
    log(true, "Keeper started in DRY-RUN mode — no transactions will be submitted");
  } else {
    log(false, "Keeper started in LIVE mode");
  }

  if (once) {
    const report = await runCycle();
    process.exit(report.errors.length > 0 && report.totalCharged === 0 ? 1 : 0);
  }

  // Loop mode
  while (true) {
    const report = await runCycle();
    const nextRun = new Date(Date.now() + INTERVAL_SECONDS * 1000);
    log(DRY_RUN, `Next cycle at ${nextRun.toISOString()} (in ${INTERVAL_SECONDS}s)`);

    if (report.errors.length > 0 && report.totalCharged === 0) {
      log(DRY_RUN, "All pages errored — will retry next cycle");
    }

    await new Promise((r) => setTimeout(r, INTERVAL_SECONDS * 1000));
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
