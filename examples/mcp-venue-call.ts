/**
 * ── ILLUSTRATIVE EXCERPT (sanitized) ────────────────────────────────────────────────────────
 * MCP-NATIVE execution: Silver Lynx places REAL orders as a CLIENT of Alpaca's official MCP
 * server. It spawns the server over stdio and calls `place_option_order` — the venue layer
 * literally proves an agent ran. MCP is the DEFAULT venue; you opt out per instance with an env
 * flag, and a classified REST fallback keeps trading if the MCP infra breaks.
 *
 * The key design point is FAILURE CLASSIFICATION: "my infra died" and "the market said no" must
 * be handled OPPOSITELY. A transport error means the order provably never reached the exchange →
 * safe to fall back to REST. A `rejected` order reached Alpaca and was refused → NEVER retried
 * (auto-retrying a rejection could double a position).
 *
 * Sanitized for the public showcase: attribution-tag prefix and account plumbing genericized;
 * hard paper-trade invariant preserved.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Where a failure originated, so callers/logs can tell MCP-infra problems from order rejections. */
export type McpFailureKind =
  | 'connect'   // couldn't spawn/connect the server (runtime missing, bad command) — MCP-layer
  | 'transport' // pipe broke / server crashed mid-call — MCP-layer
  | 'rejected'; // the server reached Alpaca and the ORDER was rejected — would fail on REST too

export class McpVenueError extends Error {
  constructor(readonly kind: McpFailureKind, message: string) {
    super(message);
    this.name = 'McpVenueError';
  }
}

let client: Client | null = null;

/** Lazily spawn Alpaca's official MCP server over stdio and connect. Singleton, respawned after a
 *  transport error so the next order gets a fresh server. */
async function getAlpacaMcp(): Promise<Client> {
  if (client) return client;
  const env = loadAlpacaEnv();
  const { command, args } = serverCommand(); // e.g. `uvx --python 3.12 alpaca-mcp-server`
  const transport = new StdioClientTransport({
    command,
    args,
    env: {
      ...getDefaultEnvironment(), // PATH/HOME so the launcher resolves
      ALPACA_API_KEY: env.keyId,
      ALPACA_SECRET_KEY: env.secret,
      ALPACA_PAPER_TRADE: 'true', // hard paper — matches the paper-only invariant
    },
    stderr: 'inherit', // surface the server's own logs into our stream
  });
  const c = new Client({ name: 'silver-lynx', version: '1.0.0' });
  try {
    await c.connect(transport);
  } catch (err) {
    throw new McpVenueError('connect', `MCP server connection failed: ${msg(err)}`);
  }
  client = c;
  return c;
}

/**
 * Submit a single-leg limit option order through Alpaca's MCP server.
 *
 * Arg shape is VERIFIED against the live alpaca-mcp-server schema (re-check on a version bump):
 * the server wants STRINGS for `qty` and `limit_price`, uses `type` (not `order_type`), supports
 * `time_in_force` "day" ONLY for options, and accepts `client_order_id` — so our attribution tag
 * survives through MCP.
 */
export async function placeSingleLegOptionViaMcp(params: {
  occSymbol: string;
  qty: number;
  side: 'buy' | 'sell';
  limitPrice: number;
  positionIntent: 'buy_to_open' | 'sell_to_close';
  clientOrderId?: string;
}): Promise<OrderResult> {
  const started = Date.now();
  const c = await getAlpacaMcp(); // throws McpVenueError('connect', …)
  const clientOrderId = params.clientOrderId ?? makeAttributionId(params.side, params.occSymbol);

  const args: Record<string, unknown> = {
    symbol: params.occSymbol,
    side: params.side,
    qty: String(params.qty),          // server expects a string count
    type: 'limit',
    limit_price: String(params.limitPrice), // server expects a string price
    time_in_force: 'day',             // options are day-only on this server
    position_intent: params.positionIntent,
    client_order_id: clientOrderId,   // attribution preserved through MCP
  };

  let result: CallToolResult;
  try {
    result = (await c.callTool({ name: 'place_option_order', arguments: args })) as CallToolResult;
  } catch (err) {
    // Pipe broke / server crashed — drop the singleton so the next order respawns a fresh server,
    // and classify as `transport`: the order provably never reached the exchange.
    await closeAlpacaMcp();
    throw new McpVenueError('transport', `MCP transport error for ${params.occSymbol}: ${msg(err)}`);
  }

  const ms = Date.now() - started;
  if (result.isError) {
    // Alpaca reached, order REFUSED. Classify as `rejected` and NEVER retry — auto-retrying a
    // rejection risks doubling a position. (The caller does NOT fall back to REST for this kind.)
    throw new McpVenueError('rejected', `Alpaca rejected ${params.occSymbol} via MCP: ${extractText(result)}`);
  }

  logMcp(`ok ${params.side} ${params.qty} ${params.occSymbol} @${params.limitPrice} (${ms}ms)`);
  return toOrderResult(params, clientOrderId, result);
}

/** MCP is the DEFAULT venue — opt OUT per instance with SLQ_EXEC_VENUE=rest (or "sdk"). */
export function mcpVenueEnabled(): boolean {
  const v = process.env.SLQ_EXEC_VENUE?.trim().toLowerCase();
  return v !== 'rest' && v !== 'sdk';
}

/** Fall back to REST ONLY for infra failures the order provably did not survive — never a rejection. */
export function shouldFallbackToRest(err: McpVenueError): boolean {
  return err.kind === 'connect' || err.kind === 'transport'; // NOT 'rejected'
}

// ── Types / helpers referenced above (shapes only; bodies elided in this excerpt) ──────────────
interface OrderResult { id: string; symbol: string; status: string; side: 'buy' | 'sell'; clientOrderId: string }
interface CallToolResult { content?: Array<{ type: string; text?: string }>; isError?: boolean }
declare function loadAlpacaEnv(): { keyId: string; secret: string };
declare function serverCommand(): { command: string; args: string[] };
declare function closeAlpacaMcp(): Promise<void>;
declare function makeAttributionId(side: 'buy' | 'sell', occSymbol: string): string;
declare function extractText(result: CallToolResult): string;
declare function toOrderResult(params: unknown, clientOrderId: string, result: CallToolResult): OrderResult;
declare function logMcp(line: string): void;
declare function msg(err: unknown): string;
