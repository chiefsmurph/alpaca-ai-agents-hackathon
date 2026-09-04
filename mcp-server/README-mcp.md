# Silver Lynx — Read-Only HTTP MCP Connector

A **read-only**, **time-boxed**, **token-gated** [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes the Silver Lynx options-execution agent's live state over HTTP
(StreamableHTTP transport). Point a judge's LLM (ChatGPT, Claude, or Claude Code)
at the URL and it can inspect the agent's account, positions, live signals, and the
full decision journal — but it **cannot place, size, or cancel a single trade.**

This is the public face of the agent's MCP surface. The full agent also runs a
richer **stdio** MCP server (`src/mcp/server.ts`) that includes guarded action
tools for the operator's own trusted client; that one is **never** exposed to the
internet. This HTTP server is the safe subset.

> Companion read: **`SECURITY.md`** — the argument for why this is impossible to
> trade through. Read it before exposing anything.

---

## What it exposes (READ TOOLS ONLY)

| Tool                  | What it returns                                                        |
| --------------------- | --------------------------------------------------------------------- |
| `slq_get_account`     | Paper account snapshot: equity, options BP, cash, buying power.       |
| `slq_get_positions`   | Open single-leg option positions with entry/current price + P&L.     |
| `slq_get_signals`     | **Genericized** upstream signal snapshot (neutral renamed scalars, opaque ticker handle), coarse market regime, socket status. |
| `slq_select_contract` | Ranks + quotes option contracts for an underlying (does NOT buy; tuned config never returned). |
| `slq_status`          | Health snapshot: feed status, account, open-position count.           |
| `slq_get_decisions`   | **Genericized** decision-journal records — whitelisted fields, hashed ticker, no dollar cost, coarse reason tag. |

**Hard-excluded (never registered, never even imported):**
`slq_place_buy`, `slq_close_position`, `slq_run_entry`, `slq_manage`.

---

## Run command

This file is designed to be dropped into the Silver Lynx repo at
`src/mcp/http-server.ts` (it imports the repo's read-only backend functions). It
runs the same way as every other script in that repo — via `tsx`.

```bash
# From the agent repo root.
# Required: the access token. Recommended: a hard expiry for the exposure window.
export MCP_PUBLIC_TOKEN="$(openssl rand -hex 24)"     # >= 24 chars or it refuses to boot
export MCP_PUBLIC_UNTIL="2026-09-06T23:59:59Z"        # 410 Gone after this instant (UTC)
export MCP_PUBLIC_ENABLED="true"                      # kill-switch: set to anything else to close instantly
export MCP_HTTP_PORT="8848"                           # optional (default 8848)

npx tsx src/mcp/http-server.ts
```

You'll see:

```
[slq-mcp-http] READ-ONLY MCP on http://0.0.0.0:8848/mcp — window OPEN, until 2026-09-06T23:59:59Z
[slq-mcp-http] tools: slq_get_account, slq_get_positions, slq_get_signals, slq_select_contract, slq_status, slq_get_decisions (READ-ONLY — no place/close/run/manage)
```

Health probe (never returns data, only window state):

```bash
curl -s http://localhost:8848/healthz
# {"ok":true,"window":"open","name":"alpaca-ai-agents-readonly"}
```

### Exposing it (done by a human, out of scope here)

Put it behind TLS + a reverse proxy so the public URL is `https://…/mcp`. Example
nginx: proxy `location /mcp` → `http://127.0.0.1:8848/mcp`. **Do not** expose the
raw HTTP port to the internet. The token still travels in the request either way;
TLS keeps it off the wire in cleartext.

---

## Client config snippet

The token can be sent as a bearer header **or** as a `?token=` query param (for
clients that only take a bare URL).

### Claude Desktop / Claude Code (`claude_desktop_config.json` or `.mcp.json`)

```json
{
  "mcpServers": {
    "silver-lynx-readonly": {
      "type": "http",
      "url": "https://YOUR-HOST/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_PUBLIC_TOKEN"
      }
    }
  }
}
```

### ChatGPT / any client that only accepts a URL (token in the query string)

```
https://YOUR-HOST/mcp?token=YOUR_MCP_PUBLIC_TOKEN
```

### Quick manual smoke test (list tools)

```bash
curl -s https://YOUR-HOST/mcp \
  -H "Authorization: Bearer YOUR_MCP_PUBLIC_TOKEN" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

You should see exactly the six read tools — and none of the mutating ones.

---

## Exposure window (important)

This connector is meant to be **public only for the judging window**, then dark.

- **`MCP_PUBLIC_UNTIL`** — an ISO-8601 instant (UTC recommended). After it passes,
  every request gets **`410 Gone`** before any auth or work happens.
- **`MCP_PUBLIC_ENABLED`** — the kill-switch. Anything other than `true` → the
  whole server answers **`410 Gone`** immediately. Flip it to shut off instantly
  without touching the process (env is re-read on every request if you restart with
  a new value; for a running process, restart or use your process manager to reload
  env).
- Both are evaluated **per request** and both **fail closed**: a missing/garbled
  `MCP_PUBLIC_UNTIL` closes the server rather than falling open to "always public".

To take it down for good: stop the process (and remove the nginx `location`). There
is no persistent state to clean up.

---

## Environment variables

| Var                  | Required | Default   | Purpose                                                        |
| -------------------- | -------- | --------- | -------------------------------------------------------------- |
| `MCP_PUBLIC_TOKEN`   | **yes**  | —         | Bearer/query access token. `>= 24` chars or the server exits. |
| `MCP_PUBLIC_UNTIL`   | no\*     | (none)    | ISO instant after which all requests get 410. \*Set it.       |
| `MCP_PUBLIC_ENABLED` | no       | `true`    | Kill-switch. Non-`true` → 410 for everything.                 |
| `MCP_HTTP_PORT`      | no       | `8848`    | Listen port.                                                   |
| `MCP_HTTP_HOST`      | no       | `0.0.0.0` | Bind address. Use `127.0.0.1` if only nginx should reach it.  |
| `MCP_HTTP_PATH`      | no       | `/mcp`    | Request path.                                                  |

Plus the repo's normal Alpaca **paper** credentials (read via `config/bootstrap`),
which are what make `slq_get_account` / `slq_get_positions` return live data. Those
keys are already paper-only in the environment this runs in.

See `.env.example` in this folder for a copy-paste starting point.
