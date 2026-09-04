import '../config/bootstrap.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ── READ-ONLY imports ONLY ─────────────────────────────────────────────────────
// The stdio server (src/mcp/server.ts) also imports the MUTATING functions
// (buyCallToOpen, closePositionBySymbol, runEntryCycle, runManageCycle). This
// public HTTP server DELIBERATELY imports NONE of them. Trade-placing code is not
// even in this module's dependency graph — there is no code path from an HTTP
// request to an order. That is the primary, structural safety guarantee.
import { getAccountSummary, getOptionPositions } from '../alpaca/executor.js';
import { getUnderlyingPrice } from '../alpaca/underlying.js';
import { fetchOptionChain } from '../alpaca/chain.js';
import { getOptionQuotes } from '../alpaca/quotes.js';
import { selectCandidates } from '../strategy/select-contract.js';
import { getSelectionConfig } from '../config/strategy-config.js';
import {
  startSecretSocketConnection,
  waitForFirstData,
  getCachedSecretSourcePositions,
  getCachedSecretRegime,
  getSecretSocketStatus,
} from '../strategy/secret/socket.js';
import { readDecisionsFromDisk } from '../bot/decision-journal.js';
// The public-projection map: NEUTRAL public key → the raw upstream source key(s) that
// populate it. This is the ONE place proprietary field names would appear, so they are
// kept in the private config module and NOT written literally in this public file. The
// map's *values* (source keys) never leave the process — only its neutral *keys* do.
import { PUBLIC_PROJECTION_MAP } from '../config/public-projection.js';

/**
 * Silver Lynx Quant — PUBLIC READ-ONLY HTTP (StreamableHTTP) MCP server.
 *
 * Serves the Silver Lynx agent's MCP surface over HTTP so a judge's LLM
 * (ChatGPT / Claude / Claude Code) can connect by URL and inspect LIVE state +
 * query the decision journal. It exposes ONLY the six read tools and can NOT place
 * a trade — see the import block above and SECURITY.md.
 *
 * Differences from the stdio server (src/mcp/server.ts):
 *   1. Transport: StreamableHTTP over Node http, not stdio.
 *   2. Tools: the six read tools ONLY. Every mutating tool is hard-excluded — not
 *      registered, and its backend function is not even imported.
 *   3. Auth: a bearer/query token is required on every request.
 *   4. Time-boxed: refuses all traffic (410 Gone) after MCP_PUBLIC_UNTIL, or
 *      immediately if the MCP_PUBLIC_ENABLED kill-switch is off.
 *
 * SDK: @modelcontextprotocol/sdk@^1.30.0 (McpServer + StreamableHTTPServerTransport,
 * registerTool with a Zod raw-shape inputSchema). Stateless transport: a fresh
 * server per POST (sessionIdGenerator: undefined) — correct + simple behind a proxy.
 */

// ── config ──────────────────────────────────────────────────────────────────
const PORT = Number(process.env.MCP_HTTP_PORT || 8848);
const HOST = process.env.MCP_HTTP_HOST || '0.0.0.0';
const PATHNAME = process.env.MCP_HTTP_PATH || '/mcp';

/** The bearer/query token every caller must present. REQUIRED — no token, no boot. */
const PUBLIC_TOKEN = process.env.MCP_PUBLIC_TOKEN || '';

/**
 * Exposure window. The server refuses ALL requests with 410 Gone once now is past
 * MCP_PUBLIC_UNTIL, or immediately if the kill-switch MCP_PUBLIC_ENABLED is not
 * "true". This is the "public for the judging window only" guarantee.
 */
const PUBLIC_UNTIL = process.env.MCP_PUBLIC_UNTIL || ''; // e.g. "2026-09-06T23:59:59Z"
const PUBLIC_ENABLED = String(process.env.MCP_PUBLIC_ENABLED || 'true').toLowerCase() === 'true';

const SERVER_NAME = 'silver-lynx-quant-readonly';
const SERVER_VERSION = '0.1.0';

// ── result helpers ────────────────────────────────────────────────────────────
/** Wrap a JS value as a structured JSON text content block. */
function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Wrap an error so the model sees the failure, not a protocol crash. */
function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

// ── PUBLIC-SAFE PROJECTIONS ─────────────────────────────────────────────────────
// The raw upstream feed positions and the raw decision-journal lines carry
// PROPRIETARY vocabulary (internal score names) and identifying data (tickers,
// dollar costs). This public server must NEVER serve them verbatim. Everything a
// data-bearing tool returns is first projected through one of the whitelists below:
// a fixed set of NEUTRAL, renamed keys — no proprietary score names, no tickers, no
// account/position dollar figures. If the upstream shape grows a new field, it is
// dropped by default (whitelist, not blacklist).

/** Opaque, stable-per-process id for a symbol so a caller can group a candidate's
 *  records without ever learning the ticker. Not reversible to a symbol. */
const _symSalt = Math.random().toString(36).slice(2);
function hashSymbol(sym: unknown): string {
  const s = typeof sym === 'string' ? sym : '';
  if (!s) return 'sym-∅';
  let h = 2166136261;
  const salted = `${_symSalt}:${s}`;
  for (let i = 0; i < salted.length; i += 1) {
    h ^= salted.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `sym-${(h >>> 0).toString(36)}`;
}

/** Any reason string can be authored upstream and may embed a proprietary score
 *  name. We do NOT try to serve it verbatim. Instead we surface only the coarse,
 *  world-safe outcome tags that prefix every journal reason
 *  ("gated+selected+sized", "…skip", etc.), and drop the free-text tail. */
function safeReasonTag(reason: unknown): string {
  const r = typeof reason === 'string' ? reason : '';
  if (!r) return '';
  // Keep only the leading outcome token(s) before the first descriptive clause.
  const head = r.split('·')[0]?.trim() ?? '';
  // Hard length cap + strip anything but a small safe charset (no embedded numbers
  // that could be a threshold, no camelCase identifiers leaking through).
  return head.replace(/[^a-zA-Z +\-]/g, '').trim().slice(0, 48);
}

// The upstream→neutral field maps below are the ONLY place a proprietary score
// name would otherwise appear. They are DELIBERATELY not written literally in this
// public file. `PUBLIC_PROJECTION_MAP` is imported from the agent's private config
// (see import at the top): it maps each NEUTRAL public key to the list of raw
// upstream source keys that may populate it, and each field's kind ('num'|'bool').
// This file therefore contains only neutral, world-safe identifiers; the proprietary
// vocabulary lives in the closed config, exactly like the internal compaction
// whitelist that the public showcase omits.
type FieldKind = 'num' | 'bool';
type ProjectionEntry = { from: readonly string[]; kind: FieldKind };
type ProjectionMap = Readonly<Record<string, ProjectionEntry>>;

/** Shape of the imported map (values elided/omitted in the public showcase). Only
 *  the neutral output keys defined in `signal`/`regime` are ever emitted. */
export interface PublicProjectionMap {
  /** raw source key holding the ticker (read only to hash it away). */
  tickerKey: string;
  /** neutral-key → source-key(s) for per-position signals. */
  signal: ProjectionMap;
  /** neutral-key → source-key(s) for the regime scalars kept verbatim (coarse). */
  regime: ProjectionMap;
  /** raw source key for market direction (coarsened to a sign). */
  regimeDirectionKey: string;
  /** raw source key for the posture multiplier (coarsened to a bit). */
  regimePostureKey: string;
}

const _num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const _bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Apply a neutral-key→source-key projection map to a raw object, emitting ONLY the
 *  neutral keys. No source key name is ever part of the OUTPUT. */
function applyProjection(src: Record<string, unknown>, map: ProjectionMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [publicKey, entry] of Object.entries(map)) {
    let val: unknown;
    for (const k of entry.from) {
      if (k in src) { val = src[k]; break; }
    }
    out[publicKey] = entry.kind === 'bool' ? _bool(val) : _num(val);
  }
  return out;
}

/** Project ONE raw upstream feed position to a compact, GENERICIZED scalar view.
 *  Reads via the imported PUBLIC_PROJECTION_MAP.signal so no proprietary field name
 *  is written in this public file, and EMITS only neutral public keys. */
function projectSignal(raw: unknown): Record<string, unknown> {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    // NO ticker — an opaque, non-reversible handle only.
    ref: hashSymbol(src[PUBLIC_PROJECTION_MAP.tickerKey]),
    ...applyProjection(src, PUBLIC_PROJECTION_MAP.signal),
  };
}

/** Project the raw market-regime context to neutral, world-safe scalars. The raw
 *  object carries proprietary-named tuning (live gate thresholds, leverage throttles);
 *  emit only a coarse, renamed regime view — no threshold values, no score names. */
function projectRegime(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const base = applyProjection(src, PUBLIC_PROJECTION_MAP.regime);
  // Coarsen the two direction/posture reads to a sign + bit — never the raw value.
  const dirRaw = src[PUBLIC_PROJECTION_MAP.regimeDirectionKey];
  const postureRaw = src[PUBLIC_PROJECTION_MAP.regimePostureKey];
  return {
    ...base,
    marketDirection:
      typeof dirRaw === 'number' ? (dirRaw > 0 ? 'up' : dirRaw < 0 ? 'down' : 'flat') : null,
    defensivePosture: typeof postureRaw === 'number' ? postureRaw < 1 : null,
  };
}

/** Whitelist ONE raw decision-journal line to public-safe fields only. Symbol → hash;
 *  reason → coarse tag; cost dropped; nothing else passes unless it is on this list. */
function projectDecision(raw: unknown): Record<string, unknown> {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pass = (k: string): unknown => src[k];
  const out: Record<string, unknown> = {
    ts: pass('ts'),
    phase: pass('phase'),
    ref: hashSymbol(src.symbol),
    action: pass('action'),
    executed: pass('executed'),
    reasonTag: safeReasonTag(src.reason),
  };
  // BUY-only execution + AI-overlay fields — all world-safe (no ticker, no dollars).
  for (const k of ['gatePct', 'governor', 'dte', 'qty', 'execMode', 'execPlan', 'sizeFactor']) {
    if (k in src) out[k] = src[k];
  }
  // NB: `cost`, `symbol`, and the raw `reason` are DELIBERATELY not copied.
  return out;
}

// ── window / kill-switch ────────────────────────────────────────────────────
type WindowState = { open: true } | { open: false; reason: string };

/** Is the public window currently open? Evaluated per request (env is live-read). */
function windowState(): WindowState {
  const enabled = String(process.env.MCP_PUBLIC_ENABLED ?? (PUBLIC_ENABLED ? 'true' : 'false'))
    .toLowerCase() === 'true';
  if (!enabled) return { open: false, reason: 'kill-switch: MCP_PUBLIC_ENABLED is off' };

  const untilRaw = process.env.MCP_PUBLIC_UNTIL ?? PUBLIC_UNTIL;
  if (untilRaw) {
    const until = new Date(untilRaw);
    if (Number.isNaN(until.getTime())) {
      // A misconfigured window fails CLOSED — we never fall open into "always public".
      return { open: false, reason: 'misconfigured MCP_PUBLIC_UNTIL — closed for safety' };
    }
    if (Date.now() > until.getTime()) {
      return { open: false, reason: `exposure window ended at ${until.toISOString()}` };
    }
  }
  return { open: true };
}

// ── auth ──────────────────────────────────────────────────────────────────
/** Pull a token from Authorization: Bearer …, X-Token, or ?token=. */
function extractToken(req: IncomingMessage, url: URL): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  const xToken = req.headers['x-token'];
  if (typeof xToken === 'string' && xToken) return xToken;
  return url.searchParams.get('token') || undefined;
}

/** Constant-time-ish equality to avoid trivially leaking token length via timing. */
function tokenMatches(candidate: string | undefined): boolean {
  if (!PUBLIC_TOKEN || !candidate) return false;
  if (candidate.length !== PUBLIC_TOKEN.length) return false;
  let mismatch = 0;
  for (let i = 0; i < candidate.length; i += 1) {
    mismatch |= candidate.charCodeAt(i) ^ PUBLIC_TOKEN.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── MCP server (READ TOOLS ONLY) ──────────────────────────────────────────────
/**
 * Build a fresh read-only McpServer. Registers EXACTLY the six read tools and
 * nothing else. There is intentionally no branch, flag, or "confirm" parameter
 * that could place an order — the mutating functions are not imported into this
 * file, so no such code path can exist.
 */
function buildReadOnlyServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'slq_get_account',
    {
      title: 'Get account summary',
      description:
        'Alpaca paper account snapshot: equity, options buying power, cash, buying power. Read-only.',
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await getAccountSummary());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'slq_get_positions',
    {
      title: 'Get option positions',
      description:
        'All open single-leg option positions with entry/current price, market value, and unrealized P&L. Read-only.',
      inputSchema: {},
    },
    async () => {
      try {
        const positions = await getOptionPositions();
        return jsonResult({ count: positions.length, positions });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'slq_get_signals',
    {
      title: 'Get feed signals (genericized)',
      description:
        'Start the signal socket, wait briefly for first data, then return a GENERICIZED, ' +
        'compact-scalar snapshot of the cached upstream signals plus the market regime and socket ' +
        'status. Read-only. The upstream feed uses proprietary score names and per-name state; this ' +
        'tool emits only a fixed whitelist of neutral scalars (conviction / hold-tier / regime flags) ' +
        'with the ticker replaced by an opaque handle — never the raw feed. Empty if the feed is off.',
      inputSchema: {
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(30_000)
          .optional()
          .describe('Max time to wait for first feed data (default 8000ms).'),
      },
    },
    async ({ timeoutMs }) => {
      try {
        startSecretSocketConnection();
        await waitForFirstData(timeoutMs ?? 8000);
        // NEVER serve getCachedSecretSourcePositions() raw — it carries proprietary
        // score names, per-name internal state, and the live watchlist (tickers).
        // Project every position through the genericized public whitelist first.
        const raw = getCachedSecretSourcePositions();
        const signals = raw.map(projectSignal);
        return jsonResult({
          status: getSecretSocketStatus(),
          regime: projectRegime(getCachedSecretRegime()),
          count: signals.length,
          signals,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'slq_select_contract',
    {
      title: 'Select a contract',
      description:
        'For an underlying: fetch spot price, pull the option chain, rank candidates via the current ' +
        'selection config, quote the top few, and return ranked picks with quotes. Read-only — this ' +
        'RANKS and QUOTES contracts; it does NOT buy anything.',
      inputSchema: {
        underlying: z.string().min(1).describe('Underlying ticker symbol, e.g. "SPY".'),
        topN: z
          .number()
          .int()
          .positive()
          .max(20)
          .optional()
          .describe('How many top ranked candidates to quote and return (default 5).'),
      },
    },
    async ({ underlying, topN }) => {
      try {
        const ticker = underlying.trim().toUpperCase();
        const cfg = getSelectionConfig();
        const spot = await getUnderlyingPrice(ticker);
        if (spot == null) {
          return jsonResult({ underlying: ticker, spot: null, picks: [], note: 'no spot price' });
        }
        const chain = await fetchOptionChain(ticker, {
          type: 'call',
          dteMin: cfg.dteMin,
          dteMax: cfg.dteMax,
          underlyingPrice: spot,
          strikePctWindow: cfg.strikePctWindow,
        });
        const ranked = selectCandidates(chain, spot, cfg);
        const limit = topN ?? 5;
        const top = ranked.slice(0, limit);
        const quotes = await getOptionQuotes(top.map((c) => c.symbol));
        const picks = top.map((c) => {
          const q = quotes.get(c.symbol);
          const spreadPct =
            q?.bid != null && q?.ask != null && q.ask > 0 ? (q.ask - q.bid) / q.ask : null;
          return {
            symbol: c.symbol,
            strike: c.strike,
            expiration: c.expiration,
            dte: c.dte,
            bid: q?.bid ?? null,
            ask: q?.ask ?? null,
            mid: q?.mid ?? null,
            spreadPct,
            passesSpreadGate: spreadPct != null ? spreadPct <= cfg.maxSpreadPct : false,
          };
        });
        // NB: `cfg` (tuned selection params: dteMin/dteMax/strikePctWindow/maxSpreadPct)
        // is used internally to rank/quote but is NEVER returned — only the per-pick
        // pass/fail against it is public.
        return jsonResult({ underlying: ticker, spot, rankedCount: ranked.length, picks });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'slq_status',
    {
      title: 'System status',
      description:
        'Overall health snapshot: signal-feed status, account summary, and open-position count. Read-only.',
      inputSchema: {},
    },
    async () => {
      const feed = getSecretSocketStatus();
      let account: unknown = null;
      let accountError: string | null = null;
      let openPositions: number | null = null;
      let positionsError: string | null = null;
      try {
        account = await getAccountSummary();
      } catch (err) {
        accountError = err instanceof Error ? err.message : String(err);
      }
      try {
        openPositions = (await getOptionPositions()).length;
      } catch (err) {
        positionsError = err instanceof Error ? err.message : String(err);
      }
      return jsonResult({ feed, account, accountError, openPositions, positionsError });
    },
  );

  server.registerTool(
    'slq_get_decisions',
    {
      title: 'Get decision journal (genericized)',
      description:
        'Return the most recent entry/manage decisions (BUY/SKIP/HOLD/CLOSE) from the decision ' +
        'journal, projected to a PUBLIC-SAFE field whitelist: ts, phase, action, executed, a coarse ' +
        'reason tag, and (on a BUY) gatePct, governor, dte, qty, execMode, execPlan, and the AI\'s ' +
        'sizeFactor. The ticker is replaced by an opaque handle and the dollar cost is dropped; the ' +
        'raw free-text reason (which may embed proprietary score names) is never served. Read-only.',
      inputSchema: {
        n: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe('How many of the most recent decisions to return (default 50).'),
      },
    },
    async ({ n }) => {
      try {
        // NEVER serve raw journal lines — they carry tickers, dollar costs, and
        // reason strings that can embed proprietary score names. Whitelist first.
        const raw = readDecisionsFromDisk(n ?? 50);
        const decisions = raw.map(projectDecision);
        return jsonResult({ count: decisions.length, decisions });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

// ── HTTP body reader ──────────────────────────────────────────────────────────
const MAX_BODY_BYTES = 1_000_000; // 1MB — MCP JSON-RPC payloads are tiny; cap abuse.

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// ── JSON-RPC error responder ────────────────────────────────────────────────
function sendJsonRpcError(
  res: ServerResponse,
  httpStatus: number,
  code: number,
  message: string,
): void {
  res.writeHead(httpStatus, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

// ── request handler ───────────────────────────────────────────────────────────
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // Lightweight liveness probe — reveals the window state, never any data.
  if (req.method === 'GET' && url.pathname === '/healthz') {
    const w = windowState();
    res.writeHead(w.open ? 200 : 410, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: w.open, window: w.open ? 'open' : 'closed', name: SERVER_NAME }));
    return;
  }

  if (url.pathname !== PATHNAME) {
    sendJsonRpcError(res, 404, -32601, 'Not found');
    return;
  }

  // 1) Time window / kill-switch — checked FIRST, before auth or any work.
  const w = windowState();
  if (!w.open) {
    sendJsonRpcError(res, 410, -32010, `Gone — ${w.reason}`);
    return;
  }

  // 2) Stateless server: only POST carries JSON-RPC. GET/DELETE (stateful session
  //    management) are not supported → 405.
  if (req.method !== 'POST') {
    sendJsonRpcError(res, 405, -32000, 'Method not allowed (stateless read-only server)');
    return;
  }

  // 3) Auth — a valid bearer/query token is mandatory.
  const token = extractToken(req, url);
  if (!tokenMatches(token)) {
    sendJsonRpcError(res, 401, -32001, 'Unauthorized — present the read-only access token');
    return;
  }

  // 4) Serve MCP over a fresh stateless transport bound to a fresh read-only server.
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJsonRpcError(res, 400, -32700, `Parse error: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
  });

  try {
    const server = buildReadOnlyServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('[slq-mcp-http] request error:', err instanceof Error ? err.message : err);
    if (!res.headersSent) sendJsonRpcError(res, 500, -32603, 'Internal server error');
  }
}

// ── startup ───────────────────────────────────────────────────────────────────
function main(): void {
  // Fail fast on misconfiguration — never boot a public server without a token.
  if (!PUBLIC_TOKEN) {
    console.error('[slq-mcp-http] FATAL: MCP_PUBLIC_TOKEN is not set. Refusing to start.');
    process.exit(1);
  }
  if (PUBLIC_TOKEN.length < 24) {
    console.error('[slq-mcp-http] FATAL: MCP_PUBLIC_TOKEN too short (need >= 24 chars). Refusing to start.');
    process.exit(1);
  }
  const w = windowState();

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[slq-mcp-http] unhandled:', err instanceof Error ? err.message : err);
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, 'Internal server error');
    });
  });

  httpServer.listen(PORT, HOST, () => {
    console.error(
      `[slq-mcp-http] READ-ONLY MCP on http://${HOST}:${PORT}${PATHNAME} ` +
        `— window ${w.open ? 'OPEN' : `CLOSED (${(w as { reason: string }).reason})`}` +
        (process.env.MCP_PUBLIC_UNTIL ? `, until ${process.env.MCP_PUBLIC_UNTIL}` : ''),
    );
    console.error('[slq-mcp-http] tools: slq_get_account, slq_get_positions, slq_get_signals, slq_select_contract, slq_status, slq_get_decisions (READ-ONLY — no place/close/run/manage)');
  });
}

main();
