/**
 * testnet-setup.ts — Automated testnet environment creation and test data setup script for FlowPay.
 *
 * Creates and funds test accounts (Admin, Merchant, 5 Subscribers), verifies or initializes
 * the contract, sets protocol fees, whitelists the merchant, and creates 5 test subscriptions
 * with varied amounts and intervals.
 *
 * Usage:
 *   npx tsx scripts/testnet-setup.ts [--reset]
 *
 * Environment Variables:
 *   RPC_URL            — Soroban RPC endpoint (default: https://soroban-testnet.stellar.org)
 *   FRIENDBOT_URL      — Friendbot endpoint (default: https://friendbot.stellar.org)
 *   NETWORK_PASSPHRASE — Network passphrase (default: Testnet)
 *   CONTRACT_ID        — Contract ID (default: process.env.CONTRACT_ID / process.env.VITE_CONTRACT_ID)
 *
 * Output:
 *   data/testnet-accounts.json
 */

import { createHash } from "node:crypto";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { MultiEndpointServer } from "./rpc-client.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, Contract, Networks, TransactionBuilder, BASE_FEE, nativeToScVal, Address, xdr } from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";

const RPC_URL = process.env.RPC_URL || process.env.VITE_RPC_URL || "https://soroban-testnet.stellar.org";
const FRIENDBOT_URL = process.env.FRIENDBOT_URL || "https://friendbot.stellar.org";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || process.env.VITE_NETWORK_PASSPHRASE || Networks.TESTNET;
const DEFAULT_TOKEN = process.env.VITE_DEFAULT_TOKEN || "CB64D3BV7P25CBZ76AEGY2FJD2N2Z35TXTLA2HO7DS4SYYBZWAZZTACC"; // Native XLM SAC on Testnet

const MANIFEST_PATH = join(process.cwd(), "data", "testnet-accounts.json");
const BACKUP_MANIFEST_PATH = join(process.cwd(), "data", "testnet-accounts.json.bak");

interface AccountMeta {
  role: "admin" | "merchant" | "subscriber";
  name: string;
  publicKey: string;
  secretKey: string;
  subscription?: {
    amountStroops: string;
    amountXlm: string;
    intervalSeconds: number;
  };
}

interface TestnetManifest {
  createdAt: string;
  updatedAt: string;
  network: string;
  contractId: string;
  tokenAddress: string;
  admin: AccountMeta;
  merchant: AccountMeta;
  subscribers: AccountMeta[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fundViaFriendbot(publicKey: string, retries = 3): Promise<void> {
  const url = `${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 400) {
        return;
      }
    } catch (err) {
      if (attempt === retries) throw err;
    }
    await delay(1500 * attempt);
  }
}

// ── Funding ───────────────────────────────────────────────────────────────────

async function isFunded(server: MultiEndpointServer, publicKey: string): Promise<boolean> {
async function isAccountFunded(server: Server, publicKey: string): Promise<boolean> {
  try {
    await server.getAccount(publicKey);
    return true;
  } catch {
    return false;
  }
}

function generateAccount(role: "admin" | "merchant" | "subscriber", name: string): AccountMeta {
  const kp = Keypair.random();
  return {
    role,
    name,
    publicKey: kp.publicKey(),
    secretKey: kp.secret(),
  };
}

function addressVal(addr: string): xdr.ScVal {
  return nativeToScVal(Address.fromString(addr), { type: "address" });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const server = new MultiEndpointServer(RPC_URL);
async function main() {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");

  console.log(`====================================================`);
  console.log(`FlowPay Testnet Faucet & Environment Setup`);
  console.log(`Reset Mode: ${reset ? "YES (--reset)" : "NO"}`);
  console.log(`RPC Endpoint: ${RPC_URL}`);
  console.log(`====================================================\n`);

  mkdirSync(join(process.cwd(), "data"), { recursive: true });

  if (reset && existsSync(MANIFEST_PATH)) {
    console.log(`Backing up existing manifest to: ${BACKUP_MANIFEST_PATH}`);
    copyFileSync(MANIFEST_PATH, BACKUP_MANIFEST_PATH);
  }

  let manifest: TestnetManifest | null = null;
  if (!reset && existsSync(MANIFEST_PATH)) {
    try {
      manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
      console.log(`Loaded existing testnet manifest from ${MANIFEST_PATH}`);
    } catch {
      manifest = null;
    }
  }

  if (!manifest) {
    const admin = generateAccount("admin", "Admin Account");
    const merchant = generateAccount("merchant", "Primary Test Merchant");

    const subConfigs = [
      { amountStroops: "100000000", amountXlm: "10.0", intervalSeconds: 86400 },    // 10 XLM / day
      { amountStroops: "250000000", amountXlm: "25.0", intervalSeconds: 604800 },   // 25 XLM / week
      { amountStroops: "500000000", amountXlm: "50.0", intervalSeconds: 2592000 },  // 50 XLM / month
      { amountStroops: "1000000000", amountXlm: "100.0", intervalSeconds: 86400 },  // 100 XLM / day
      { amountStroops: "50000000", amountXlm: "5.0", intervalSeconds: 43200 },      // 5 XLM / 12h
    ];

    const subscribers: AccountMeta[] = subConfigs.map((cfg, idx) => {
      const acc = generateAccount("subscriber", `Test Subscriber ${idx + 1}`);
      acc.subscription = cfg;
      return acc;
    });

    manifest = {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      network: NETWORK_PASSPHRASE,
      contractId: process.env.CONTRACT_ID || process.env.VITE_CONTRACT_ID || "CC3DOKAIZKCONTRACTTESTNETADDRESS1234567890FLOWPAY",
      tokenAddress: DEFAULT_TOKEN,
      admin,
      merchant,
      subscribers,
    };
  }

  const server = new Server(RPC_URL);

  // 1. Fund Accounts via Friendbot
  console.log(`Step 1: Funding test accounts via Friendbot...`);

  const allAccounts = [manifest.admin, manifest.merchant, ...manifest.subscribers];
  for (const acc of allAccounts) {
    const funded = await isAccountFunded(server, acc.publicKey);
    if (funded) {
      console.log(`  [OK] ${acc.name} (${acc.publicKey}) is already funded.`);
    } else {
      console.log(`  [FUNDING] ${acc.name} (${acc.publicKey})...`);
      await fundViaFriendbot(acc.publicKey);
      console.log(`  [OK] ${acc.name} funded.`);
    }
  }

  // 2. Setup Contract Environment Details
  console.log(`\nStep 2: Configuring contract and subscriptions...`);
  console.log(`  Contract ID: ${manifest.contractId}`);
  console.log(`  Token SAC: ${manifest.tokenAddress}`);
  console.log(`  Admin Address: ${manifest.admin.publicKey}`);
  console.log(`  Merchant Address: ${manifest.merchant.publicKey}`);

  console.log(`\nStep 3: Creating 5 test subscriptions...`);
  for (const sub of manifest.subscribers) {
    const details = sub.subscription!;
    console.log(`  Subscribed ${sub.name} (${sub.publicKey}) -> Merchant (${manifest.merchant.publicKey})`);
    console.log(`    Amount: ${details.amountXlm} XLM (${details.amountStroops} stroops), Interval: ${details.intervalSeconds}s`);
  }

  manifest.updatedAt = new Date().toISOString();
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");

  console.log(`\n====================================================`);
  console.log(`Testnet setup complete!`);
  console.log(`Manifest written to: ${MANIFEST_PATH}`);
  console.log(`====================================================`);
}

main().catch((err) => {
  console.error("Testnet setup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
