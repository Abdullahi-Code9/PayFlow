import { SorobanRpc } from "@stellar/stellar-sdk";
import * as fs from "fs";
import * as path from "path";

// Shared logger utility
const createLogger = () => {
  return {
    info: (msg: string) => console.log(`[INFO] ${new Date().toISOString()} ${msg}`),
    error: (msg: string) => console.error(`[ERROR] ${new Date().toISOString()} ${msg}`),
    warn: (msg: string) => console.warn(`[WARN] ${new Date().toISOString()} ${msg}`),
    debug: (msg: string) => console.log(`[DEBUG] ${new Date().toISOString()} ${msg}`),
  };
};

const logger = createLogger();

interface WatermarkState {
  lastCursor: string;
  lastLedger: number;
  seenCount: number;
  timestamp: number;
}

const WATERMARK_FILE = path.join(process.cwd(), ".watch-events-watermark.json");
const MAX_SEEN_SET_SIZE = 10000; // Bound the seen-set
const CURSOR_WINDOW = 100; // Keep only recent cursors

/**
 * Load watermark from disk to resume from last position
 */
function loadWatermark(): WatermarkState {
  try {
    if (fs.existsSync(WATERMARK_FILE)) {
      const data = JSON.parse(fs.readFileSync(WATERMARK_FILE, "utf8"));
      logger.info(`Loaded watermark: cursor=${data.lastCursor}, ledger=${data.lastLedger}, seen=${data.seenCount}`);
      return data;
    }
  } catch (err) {
    logger.warn(`Failed to load watermark: ${err}`);
  }
  return { lastCursor: "", lastLedger: 0, seenCount: 0, timestamp: Date.now() };
}

/**
 * Save watermark to disk for crash recovery
 */
function saveWatermark(state: WatermarkState): void {
  try {
    fs.writeFileSync(WATERMARK_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.error(`Failed to save watermark: ${err}`);
  }
}

/**
 * Prune old cursor entries to prevent unbounded memory growth
 */
function pruneCursors(cursors: string[]): string[] {
  if (cursors.length > CURSOR_WINDOW) {
    return cursors.slice(-CURSOR_WINDOW);
  }
  return cursors;
}

/**
 * Main event watcher with bounded memory and deterministic pagination
 */
async function watchEvents(options: {
  rpcUrl: string;
  contractId: string;
  behind?: number;
  stopAfter?: number;
}): Promise<void> {
  const { rpcUrl, contractId, behind = 0, stopAfter = Infinity } = options;

  const server = new SorobanRpc.Server(rpcUrl);
  let watermark = loadWatermark();
  let eventCount = 0;
  const seenEventIds = new Set<string>();
  let recentCursors: string[] = [];

  logger.info(`Starting event watcher for contract ${contractId}`);
  logger.info(`RPC: ${rpcUrl}, Behind: ${behind}, StopAfter: ${stopAfter}`);

  try {
    while (eventCount < stopAfter) {
      try {
        // Get latest ledger for "behind" offset
        const latestLedger = await server.getLatestLedger();
        const targetLedger = Math.max(1, latestLedger.sequence - behind);

        logger.debug(`Latest ledger: ${latestLedger.sequence}, Target: ${targetLedger}`);

        // Fetch events with stable pagination cursor
        const eventRequest: SorobanRpc.GetEventsRequest = {
          startLedger: watermark.lastLedger || targetLedger,
          filters: [
            {
              type: "contract",
              contractIds: [contractId],
            },
          ],
          limit: 100,
          // Use pagination cursor for deterministic page traversal
          cursor: watermark.lastCursor || undefined,
        };

        const response = await server.getEvents(eventRequest);

        if (!response.events || response.events.length === 0) {
          logger.info("No new events, waiting...");
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        logger.info(`Fetched ${response.events.length} events`);

        for (const event of response.events) {
          // Create deterministic event ID from ledger + index to track duplicates
          const eventId = `${event.ledger}-${event.index}`;

          // Skip duplicates to prevent double-processing
          if (seenEventIds.has(eventId)) {
            logger.debug(`Skipping duplicate event: ${eventId}`);
            continue;
          }

          // Bound the seen-set with a watermark
          if (seenEventIds.size >= MAX_SEEN_SET_SIZE) {
            logger.warn(
              `Seen-set reached capacity (${MAX_SEEN_SET_SIZE}), clearing old entries`
            );
            seenEventIds.clear();
          }

          seenEventIds.add(eventId);

          logger.info(
            `Event #${eventCount + 1}: Ledger ${event.ledger}, Type: ${event.type}`
          );

          // Process event
          if (event.type === "contract") {
            const contractEvent = event as unknown as {
              contractId: string;
              topic: string[];
              value: { xdr: string };
            };
            logger.info(
              `  Contract: ${contractEvent.contractId}, Topics: ${contractEvent.topic.length}`
            );
          }

          eventCount++;

          if (eventCount >= stopAfter) {
            logger.info(`Reached stop limit (${stopAfter} events)`);
            break;
          }
        }

        // Update watermark with latest cursor and ledger for crash recovery
        if (response.latestLedger) {
          watermark.lastLedger = response.latestLedger;
          watermark.seenCount = seenEventIds.size;
          watermark.timestamp = Date.now();

          // Update cursor if provided (deterministic pagination)
          if (response.latestCursor) {
            recentCursors.push(response.latestCursor);
            recentCursors = pruneCursors(recentCursors);
            watermark.lastCursor = response.latestCursor;
          }

          saveWatermark(watermark);
          logger.debug(
            `Updated watermark: ledger=${watermark.lastLedger}, cursor=${watermark.lastCursor}`
          );
        }

        // Stop if we've reached the target ledger
        if (response.latestLedger && response.latestLedger >= targetLedger) {
          logger.info(
            `Caught up to target ledger ${targetLedger}, waiting for new events...`
          );
          await new Promise((r) => setTimeout(r, 5000));
        }
      } catch (err) {
        logger.error(`Error fetching events: ${err}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    logger.info(`Event watching completed. Total events: ${eventCount}`);
  } finally {
    saveWatermark(watermark);
    logger.info(`Final watermark saved`);
  }
}

// Parse CLI arguments
const args = process.argv.slice(2);
const options: {
  rpcUrl: string;
  contractId: string;
  behind?: number;
  stopAfter?: number;
} = {
  rpcUrl: "http://localhost:8000/soroban/rpc",
  contractId: "",
};

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--rpc" && args[i + 1]) {
    options.rpcUrl = args[++i];
  } else if (args[i] === "--contract" && args[i + 1]) {
    options.contractId = args[++i];
  } else if (args[i] === "--behind" && args[i + 1]) {
    options.behind = parseInt(args[++i], 10);
  } else if (args[i] === "--stop-after" && args[i + 1]) {
    options.stopAfter = parseInt(args[++i], 10);
  }
}

if (!options.contractId) {
  logger.error("Missing required --contract argument");
  process.exit(1);
}

// Run the watcher
watchEvents(options).catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
