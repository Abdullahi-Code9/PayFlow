import { Server } from "@stellar/stellar-sdk/rpc";

/**
 * Interface representing a parsed event from the blockchain.
 */
export interface ParsedRpcEvent {
  eventName: string;
  user: string;
  timestamp: number; // Unix timestamp in seconds
  merchant?: string;
  amount?: string;
  interval?: string;
}

/**
 * Parse a field safely from the RPC event value, supporting both
 * raw and wrapped SDK structures.
 */
function parseEventValueField(value: any, field: string): string | undefined {
  if (!value) return undefined;
  const base = value._value?.[field] ?? value[field];
  if (base == null) return undefined;
  if (typeof base === "string") return base;
  if (typeof base === "number" || typeof base === "bigint") return base.toString();
  if (typeof base.toString === "function") return base.toString();
  return undefined;
}

/**
 * Parse the close time of a ledger from various RPC event structures.
 */
function parseEventTime(event: any): number {
  if (typeof event.ledgerCloseTime === "number") return event.ledgerCloseTime;
  if (typeof event.ledgerCloseTime === "string") return Number(event.ledgerCloseTime) || 0;
  if (typeof event.timestamp === "string") return Math.floor(Date.parse(event.timestamp) / 1000);
  return Math.floor(Date.now() / 1000);
}

/**
 * Fetch and paginate all relevant contract events from the Soroban RPC.
 * This function returns a sorted list of parsed subscription and cancellation events.
 */
export async function fetchEventsFromRpc(): Promise<ParsedRpcEvent[]> {
  const contractId = process.env.CONTRACT_ID || process.env.VITE_CONTRACT_ID || "";
  const rpcUrl = process.env.RPC_URL || process.env.VITE_RPC_URL || "https://soroban-testnet.stellar.org";

  if (!contractId) {
    throw new Error(
      "CONTRACT_ID or VITE_CONTRACT_ID environment variable is required for RPC event fallback."
    );
  }

  const server = new Server(rpcUrl);
  const events: ParsedRpcEvent[] = [];
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const params: any = {
      filters: [{ type: "contract", contractIds: [contractId] }],
      limit: 1000,
    };

    if (cursor) {
      params.cursor = cursor;
    } else {
      params.startLedger = 1;
    }

    let response;
    try {
      response = await server.getEvents(params);
    } catch (err: any) {
      console.error(`Error querying RPC events: ${err?.message || err}`);
      throw err;
    }

    if (!response.events || response.events.length === 0) {
      hasMore = false;
      break;
    }

    for (const rawEvent of response.events) {
      const topic = rawEvent.topic;
      if (!topic || topic.length < 2) continue;

      const eventName = topic[0]?.toString();
      if (!eventName) continue;

      // Filter only for subscriber events
      if (
        eventName !== "subscribed" &&
        eventName !== "cancelled" &&
        eventName !== "cancelled_with_refund"
      ) {
        continue;
      }

      const user = topic[1]?.toString() || "";
      const timestamp = parseEventTime(rawEvent);

      let merchant: string | undefined;
      let amount: string | undefined;
      let interval: string | undefined;

      if (rawEvent.value) {
        merchant = parseEventValueField(rawEvent.value, "merchant");
        amount = parseEventValueField(rawEvent.value, "amount") ||
                 parseEventValueField(rawEvent.value, "gross") ||
                 parseEventValueField(rawEvent.value, "net");
        interval = parseEventValueField(rawEvent.value, "interval");
      }

      events.push({
        eventName,
        user,
        timestamp,
        merchant,
        amount,
        interval,
      });
    }

    if (response.events.length < 1000) {
      hasMore = false;
    } else {
      cursor = (response as any).cursor;
      if (!cursor) {
        hasMore = false;
      }
    }
  }

  // Sort chronologically
  return events.sort((a, b) => a.timestamp - b.timestamp);
}
