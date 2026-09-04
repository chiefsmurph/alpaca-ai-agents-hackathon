# SECURITY — Read-Only HTTP MCP Connector

**Claim:** it is *impossible* to place, modify, size, or cancel a trade through this
server. Below is why — in layers, so that even if one layer were wrong, the others
still hold. This is defense in depth; the first layer alone is the real guarantee.

---

## Layer 0 — Structural: the trade code is not in the program

The single strongest guarantee is that **the functions that place or close orders
are never imported into this file.**

The full stdio MCP server (`src/mcp/server.ts`) imports:

```
buyCallToOpen, closePositionBySymbol   (from alpaca/executor)
runEntryCycle                          (from bot/entry-loop)
runManageCycle                         (from bot/manage-loop)
```

`http-server.ts` imports **none of them.** Its import list is exactly the read-only
backend functions (`getAccountSummary`, `getOptionPositions`, `getUnderlyingPrice`,
`fetchOptionChain`, `getOptionQuotes`, `selectCandidates`, `readDecisionsFromDisk`,
and the read-only signal-socket getters), plus one pure-data config import
(`PUBLIC_PROJECTION_MAP` — a static neutral-key→source-key map used only to sanitize
outputs; it holds no functions and touches nothing). Because the order-placing
functions are not in this module's dependency graph, **there is no call path from an
HTTP request to a broker order.** This is verifiable by reading the top of the file —
no reflection, no dynamic `import()`, no `eval`.

## Layer 1 — Surface: only six tools are registered

`buildReadOnlyServer()` calls `registerTool` exactly six times, all read tools.
The mutating tool *names* (`slq_place_buy`, `slq_close_position`, `slq_run_entry`,
`slq_manage`) are never registered, so a client's `tools/list` cannot even see
them, and a `tools/call` for one returns "unknown tool". There is no `execute` or
`confirm` parameter anywhere in this file — the guarded-action pattern from the
stdio server does not exist here.

## Layer 2 — Auth: a token is mandatory

- Every request must present a valid token via `Authorization: Bearer …`,
  `X-Token`, or `?token=`.
- The token is compared with a length check + constant-time-style XOR loop to avoid
  leaking length/positions via timing.
- The server **refuses to boot** without `MCP_PUBLIC_TOKEN`, and refuses tokens
  shorter than 24 characters. No token → no server.

## Layer 3 — Time box: it turns itself off

- `MCP_PUBLIC_UNTIL` (ISO instant): after it passes, **every** request is answered
  `410 Gone` — checked before auth and before any handler work.
- `MCP_PUBLIC_ENABLED` kill-switch: any value other than `true` → `410 Gone` for
  everything, immediately.
- **Fails closed:** a missing or unparseable `MCP_PUBLIC_UNTIL` closes the server,
  never falls open to "always public". Same for the kill-switch default posture in
  an ops mistake — the window check runs first and errs shut.

## Layer 4 — Transport hardening

- **Stateless** StreamableHTTP: a fresh server + transport per POST, no session
  state to hijack or replay. `GET`/`DELETE` (stateful session management) → `405`.
- Request bodies are capped at **1 MB**; oversized payloads are rejected and the
  socket destroyed.
- Unknown paths → `404`; only `POST /mcp` does anything. `GET /healthz` returns the
  window state only — never account or position data.
- Errors are wrapped as MCP `isError` results or JSON-RPC errors; the process does
  not crash on a bad call.

## Layer 5 — Blast radius (even if every layer above failed)

- The underlying Alpaca credentials in this environment are **paper** (simulated)
  keys. There is no live-money account reachable from this process.
- The six tools only **read**: account snapshot, positions, a *genericized* signal
  snapshot, a chain-ranking/quote computation, health, and *genericized* journal
  lines. None writes to disk, the broker, or the signal socket. `slq_select_contract`
  *ranks and quotes* — it is the closest to "trade-shaped" and it still places nothing.

## Layer 6 — Alpha containment: no proprietary vocabulary crosses the wire

Even a fully-authorized caller inside the window cannot extract the closed alpha,
because the two data-bearing tools **project before they respond** — they never
serialize the raw upstream feed or the raw journal:

- `slq_get_signals` runs `getCachedSecretSourcePositions()` through a fixed
  **genericized whitelist** (`projectSignal`): a small set of NEUTRAL renamed
  scalars (conviction / hold-tier / regime flags), the ticker replaced by an opaque
  non-reversible handle, and the market regime coarsened to a sign + posture bit
  (`projectRegime`). No proprietary score name, per-name internal state, live
  watchlist ticker, or tuned threshold is emitted. New upstream fields are dropped
  by default (whitelist, not blacklist).
- `slq_get_decisions` runs each journal line through `projectDecision`: a
  field whitelist (`ts, phase, action, executed, gatePct, governor, dte, qty,
  execMode, execPlan, sizeFactor`), the `symbol` hashed to the same opaque handle,
  the dollar `cost` dropped, and the free-text `reason` reduced to a coarse outcome
  tag (`safeReasonTag`) so a score name embedded in a reason string can't leak.
- `slq_select_contract` uses the tuned selection config to rank/quote but **returns
  only** the per-pick `passesSpreadGate` boolean — never the config itself.

---

## What this server intentionally does NOT do

- It does not proxy to the stdio server or the running bot process — it calls the
  same read functions directly, in-process, with no IPC to the trading loop.
- It does not accept any parameter that changes agent behavior (no config writes,
  no cycle triggers, no order params).
- It does not expose the proprietary upstream research/signal engine's internals —
  `slq_get_signals` never returns the raw cached feed. It projects each position
  through a genericized whitelist (`projectSignal`/`projectRegime`) that emits only
  neutral renamed scalars with the ticker replaced by an opaque handle. See Layer 6.

## Reviewer checklist (2-minute audit)

1. Open `http-server.ts`, read the import block: confirm **no** `buyCallToOpen`,
   `closePositionBySymbol`, `runEntryCycle`, `runManageCycle`.
2. Count `registerTool(` calls: exactly **6**, all `slq_get_*`/`slq_status`/
   `slq_select_contract`.
3. Search the file for `confirm`, `execute`, `place`, `close`, `submit` used as a
   *code path* — there are none (only prose in descriptions saying it does NOT buy).
4. Confirm the window check (`windowState()`) runs **before** auth and handler.
5. Confirm boot-time guards: exits without a `>= 24`-char `MCP_PUBLIC_TOKEN`.

If all five hold, the server can read live state and cannot trade.
