/**
 * validate-config.ts — Environment configuration validator for FlowPay.
 *
 * Reads .env or .env.local and validates that all required keeper variables
 * are present and correctly formatted using Zod schemas defined in config.ts.
 * Useful for CI pipelines and local developer workflows.
 *
 * Usage:
 *   npx tsx scripts/validate-config.ts
 *
 * Checks:
 *   - CONTRACT_ID     — non-empty, valid Stellar contract ID
 *   - RPC_URL          — valid http/https URL
 *   - SECRET_KEY       — valid Stellar secret key
 *   - BATCH_SIZE       — integer 1–200
 *   - INTERVAL_SECONDS — integer ≥ 60
 *   - WEBHOOK_URL      — optional, validated if present
 *
 * Exit codes:
 *   0 — all validations passed
 *   1 — one or more validations failed
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import { ConfigSchema, formatConfigErrors } from "./config";
import { logger } from "./logger";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── .env Parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a .env file into a key-value map.
 * Handles comments, empty lines, and quoted values.
 */
function parseEnvFile(filePath: string): Map<string, string> {
  const vars = new Map<string, string>();
  const content = readFileSync(filePath, "utf-8");

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    vars.set(key, value);
  }

  return vars;
}

/**
 * Locate and parse the environment file.
 * Prefers .env.local over .env (matching Vite conventions).
 */
function loadEnv(projectRoot: string): Map<string, string> {
  const envLocal = resolve(projectRoot, ".env.local");
  const envDefault = resolve(projectRoot, ".env");

  if (existsSync(envLocal)) {
    logger.info(`Reading configuration from: .env.local`);
    return parseEnvFile(envLocal);
  }

  if (existsSync(envDefault)) {
    logger.info(`Reading configuration from: .env`);
    return parseEnvFile(envDefault);
  }

  logger.error("ERROR: No .env or .env.local file found in project root.");
  logger.error("  Create one from .env.example or set required variables:");
  logger.error("    CONTRACT_ID, RPC_URL, SECRET_KEY, BATCH_SIZE, INTERVAL_SECONDS");
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const projectRoot = resolve(__dirname, "..");
  const envVars = loadEnv(projectRoot);

  // Convert Map to plain object for Zod
  const envObject: Record<string, string | undefined> = {};
  for (const [key, value] of envVars) {
    envObject[key] = value;
  }

  logger.info("");

  const result = ConfigSchema.safeParse(envObject);

  if (result.success) {
    const config = result.data;
    logger.info("✓ CONTRACT_ID ..............", config.CONTRACT_ID);
    logger.info("✓ RPC_URL ..................", config.RPC_URL);
    logger.info("✓ SECRET_KEY ...............", "******** (valid)");
    logger.info("✓ BATCH_SIZE ...............", config.BATCH_SIZE);
    logger.info("✓ INTERVAL_SECONDS .........", config.INTERVAL_SECONDS);
    if (config.WEBHOOK_URL) {
      logger.info("✓ WEBHOOK_URL ..............", config.WEBHOOK_URL);
    }
    if (config.NETWORK_PASSPHRASE) {
      logger.info("✓ NETWORK_PASSPHRASE .......", config.NETWORK_PASSPHRASE);
    }
    logger.info("\nAll configuration checks passed.\n");
    process.exit(0);
  }

  // Validation failed — display all issues with human-readable messages
  const errors = formatConfigErrors(result.error);

  logger.info("Configuration validation failed:\n");
  for (const msg of errors) {
    logger.info(`  ${msg}`);
  }

  logger.info("");
  logger.info(`Validation failed: ${errors.length} issue(s) found.`);
  logger.info("Fix the above errors and re-run.");
  process.exit(1);
}

main();
