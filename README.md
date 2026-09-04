# Silver Lynx Quant — Alpaca AI Trading Agents Hackathon entry

> A live, fully-transparent, LLM-in-the-loop options-execution agent that trades private
> alpha through a multi-layer deterministic risk gauntlet — executing through Alpaca's
> official MCP server, and exposing its own read-only MCP server so a judge's LLM can
> inspect it in real time.

*Team **Silver Lynx Quant** · built for the [Alpaca AI Trading Agents Hackathon](https://lablab.ai/ai-hackathons/alpaca-ai-trading-agents-hackathon) on lablab.ai · Alpaca paper trading.*

---

## Open reference vs. closed alpha — and what you can run yourself

The **full agent runs in a private repo** (closed alpha — the upstream research/signal engine and
its proprietary scores). **THIS repo is the open, auditable reference of its execution & risk
layer** — the exact patterns that keep a bounded LLM safe on live capital, reimplemented clean-room,
**plus runnable tests you can execute yourself:**

```bash
npm install && npm test
```

Nothing here reproduces alpha: the gates are generic risk checks, the score names are genericized,
the tuned thresholds are omitted. What *is* here is the load-bearing safety machinery — and it runs.

### What's runnable

| Command | What it does |
|---------|--------------|
| `npm test` | 27 tests via `node --test`. The headline one drives a fake venue's ask **up 50% mid-fill** and asserts **no produced price ever crosses the arrival-anchored ceiling**; others prove the AI-overlay clamp (`sizeFactor 5 → 2×`, reject → 0, malformed → fail-open) and the token-budget cap. |
| `npm run typecheck` | `tsc --noEmit` — the `src/` + `test/` modules type-clean. |
| `npm run risk-gauntlet:demo` | Runs three candidates through the ~9-gate deterministic gauntlet and prints which gate stopped each. |
| `npm run token-budget:demo` | Compacts one big synthetic nested position and prints **raw vs compacted char size** (~100× smaller here) — the two-tier scalar projection. |
| `npm run journal-tally` | Audits a **synthetic** decision journal (`data/decisions.sample.jsonl`) and prints the AI-overlay footprint: upsized / downsized / held-at-gate / vetoed + median sizeFactor. *Not just auditable — audited.* |

### Repo map

```
package.json / tsconfig.json  — runnable ESM + node --test setup
src/                          — clean-room runnable reference modules (see src/README.md)
  risk-gauntlet.ts            — ~9 named, kill-switchable deterministic risk gates
  ai-overlay-guardrail.ts     — the bounded veto/resize clamp + fail-open passthrough
  arrival-ceiling.ts          — the arrival-anchored $ ceiling (can't chase a rising ask)
  token-budget.ts             — two-tier compact-scalar projection under a hard char cap
test/                         — node --test suites (all green)
  arrival-ceiling.test.ts     — ask rises 50% mid-fill → no price ever exceeds the ceiling
  ai-overlay-guardrail.test.ts— clamp / veto / fail-open passthrough
  token-budget.test.ts        — under the cap, key scalars preserved
scripts/journal-tally.ts      — the decision-journal audit tally
data/decisions.sample.jsonl   — SYNTHETIC sample journal (no real tickers, no dollars)
examples/                     — the original sanitized read-only excerpts (intent, not runnable)
mcp-server/                   — read-only HTTP MCP connector + SECURITY.md
packages/occ-symbol/          — vendored public OSS OCC-symbol parser (npm + PyPI)
architecture.md               — the deep ENG + TRADE architecture write-up
```

---

## The one-paragraph pitch

Most trading-agent entries are an LLM wired directly to a broker. **Silver Lynx is the
opposite: a proven deterministic strategy with a *bounded* AI overlay bolted on top.** Every
candidate first clears roughly ten kill-switchable, deterministic risk gates. Only then does
a model get a single forced tool-call permitting *only two moves* — **veto** (size → 0) or
**resize** inside a hard clamp of `[0, 2×]`. The AI can never invent risk, never widen a gate,
never bid above the ask. And it **fails open**: if the model errors or times out, the proven
strategy keeps trading at gate size instead of going dark. Execution is MCP-native both ways —
it places real orders as a *client* of Alpaca's official MCP server, and exposes its *own*
read-only MCP server for inspection.

---

## How we prove the AI is worth it — the decision journal, not a P&L race

We run Silver Lynx as a small fleet of **three live cells**, each a distinct risk profile:

| Cell | Holding-period window | Leverage | AI overlay |
|------|----------------------|----------|-----------|
| Conservative sleeve | longer-dated | ~1× | off |
| Aggressive sleeve | short-dated | ~1× | off |
| **Flagship** | widest window (favors short) | ~1.9× | **on** |

This is an honest **portfolio of risk profiles**, not a "controlled experiment." The cells
differ in more than the AI — holding period *and* leverage — so a raw account-vs-account P&L
delta is confounded. We do not rest the AI-value claim on it.

**Instead, we measure the AI where it actually acts: at the decision.** Every candidate the
agent evaluates is appended as one structured JSON line to a decision journal —
**37,881 decisions and counting** — recording:

- what the **deterministic gate** decided (approve at a computed size, or skip with a named
  reason), and
- on the flagship, exactly **how the AI modified it** — a veto (size → 0) or a resize expressed
  as a bounded factor clamped to `[0, 2×]` of the gate's size.

Because the AI can *only* act inside that clamp, its footprint is **fully separable** from the
strategy's. Filter the journal to the flagship's AI interventions and you can replay, one by
one, every candidate the model vetoed and every one it up- or down-sized — each with the gate's
original decision alongside. That is a *demonstrable, replayable* measure of the AI's judgment,
cleaner than any single P&L number. And it's **live-queryable**: the agent exposes the journal
through a read-only MCP tool, so a judge can point their own LLM at the running system and pull
recent decisions with the gate percentage, the governor, and the AI's size factor attached.

---

## Why it's credible — the quant-shop split

Upstream trading signals come from a **proprietary research engine** (our signal desk). Silver
Lynx is the **execution-and-risk desk**. We separated them on purpose, exactly like a real
quant shop:

- The research engine stays a **black box**. It is *not* in this repo and is *not* what you're
  judging.
- The agent is **100% open** and is the thing under evaluation.
- The two touch through a **single typed, read-only socket** that returns bounded scalars —
  proprietary conviction scores, a hold-tier, a market-regime context. No shared code, no RPC
  into the engine's internals, no write-back path. The agent physically cannot leak the edge,
  because it never has it.

The agent doesn't *obey* the signal — it **re-derives its own decisions** on top: its own risk
gates, its own sizing, its own execution policy, and the LLM overlay. **The alpha proposes; the
risk-aware AI agent disposes.** The closed alpha is what makes the open agent credible — it
proves the real logic isn't hidden inside the thing being judged.

> A brief outage of the research engine doesn't strand open risk: the agent runs on a
> bounded-age snapshot, self-reports its staleness, and keeps managing exits. It's an
> operator-grade dependency, not a single point of failure.

---

## Five things no other entry has together

1. **The AI proves its worth line by line.** 37,881 journaled decisions; every AI intervention
   (veto → 0, or resize within `[0, 2×]`) auditable trade-by-trade against the gate's original
   call — not a confounded account race.
2. **A rising ask literally cannot make us overpay.** One absolute-dollar ceiling is anchored to the
   *arrival* quote and clamps every rung, walk step, spray shot, and sweep. A test drives the
   ask up 50% mid-fill and asserts no recorded price ever crosses the ceiling.
3. **A costly early API bill became a two-tier token budget.** One raw feed position is tens of
   thousands of tokens of nested state; serialized whole it burned real money fast against a
   hard prepaid cap. We project it to a few hundred curated scalars under a strict char budget —
   roughly **30× cheaper per call**, and the model sees *more* structured signal.
4. **The AI is bounded by math, and it fails open.** A forced tool-call lets the model only
   reject (size 0) or resize within `[0, 2×]`; its multi-leg fill plan prices each leg as a
   fraction of the spread clamped to `[0, 1]` — a hard guarantee against the classic LLM
   chase-the-ask failure. If the model errors, the proven strategy keeps trading.
5. **The agent is both an MCP client AND a read-only MCP server.** It places real orders through
   Alpaca's official MCP server, and exposes its own inspection server so a grader's LLM can
   reason over live account state — and every decision comes back as a queryable JSON line.

*Pocket runner-up:* **[occ-symbol](https://github.com/chiefsmurph/occ-symbol)** — a
dual-published npm + PyPI OCC option-symbol parser that reimplements JavaScript's
half-away-from-zero rounding in Python so the two ports stay byte-identical on exact
half-thousandth strikes. Boring correctness, shipped as OSS. ([npm](https://www.npmjs.com/package/occ-symbol) · [PyPI](https://pypi.org/project/occ-symbol/) · [occsymbol.com](https://occsymbol.com))

---

## Architecture at a glance

```
   ┌─────────────────────────┐        one typed, read-only socket
   │  Proprietary research   │        (bounded scalars: conviction,
   │  engine  (signal desk,  │────▶   hold-tier, market-regime — no
   │  NOT in this repo)      │        shared code, no write-back)
   └─────────────────────────┘
                │
                ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  SILVER LYNX  (execution & risk desk — this repo)             │
   │                                                              │
   │  1. Deterministic risk gauntlet  (~10 kill-switchable gates) │
   │       regime block → dedup → conviction floor → position &   │
   │       concentration caps → falling-knife pre-gate → spread   │
   │       ── cheap scalar gates run FIRST; zero LLM tokens on    │
   │          names that fail risk ──                             │
   │                     │  survivors only                        │
   │                     ▼                                        │
   │  2. Bounded AI overlay  (forced tool-call: veto | resize)   │
   │       clamp sizeFactor → [0, 2×];  fails OPEN at gate size   │
   │                     │                                        │
   │                     ▼                                        │
   │  3. Arrival-anchored execution engine                       │
   │       one $ ceiling; multi-leg plan, each leg a clamped     │
   │       fraction [0,1] of the spread → cannot chase the ask   │
   │                     │                                        │
   │                     ▼                                        │
   │  4. Venue layer  ── MCP by default ──                       │
   └────────────────────┼─────────────────────────────────────────┘
                        │                         ▲
       places orders    ▼                         │  read-only MCP server
   ┌─────────────────────────┐         ┌──────────┴──────────────┐
   │ Alpaca official MCP     │         │  a judge's LLM inspects  │
   │ server (place_option_…) │         │  live state + journal    │
   └─────────────────────────┘         └─────────────────────────┘
```

Full write-up in [`architecture.md`](./architecture.md). Illustrative, sanitized code excerpts
are under [`examples/`](./examples/).

---

## How to connect the MCP server

Silver Lynx exposes a **read-only** MCP server so any MCP-capable client (Claude Desktop, a
custom agent, a judge's own LLM) can inspect the running system: account snapshot, live
positions, upstream signals (genericized), status, and the decision journal. **Only the
read/inspection tools are exposed publicly** — the order-placing tools stay private.

Public (read-only) tools:

| Tool | What it returns |
|------|-----------------|
| `slq_get_account` | equity, buying power, account posture |
| `slq_get_positions` | live open positions |
| `slq_get_signals` | current upstream signals (genericized scalars) |
| `slq_get_decisions` | recent decision-journal entries (gate %, governor, AI size factor) |
| `slq_status` | run-loop health, feed staleness, kickoff-gate state |
| `slq_select_contract` | dry-run contract selection for a candidate |

> The mutating tools (`slq_place_buy`, `slq_close_position`, `slq_run_entry`, `slq_manage`)
> exist in the private agent but are **never exposed on the public server**.

### Option A — stdio (local, today)

Point any MCP client at the read-only server over stdio. Example client config:

```jsonc
{
  "mcpServers": {
    "silver-lynx": {
      "command": "npx",
      "args": ["-y", "silver-lynx-mcp", "--read-only"],
      "env": {
        // read-only token; grants inspection tools only, never order placement
        "SLQ_MCP_TOKEN": "<your-read-only-token>"
      }
    }
  }
}
```

### Option B — read-only HTTP URL (coming)

For remote graders we're standing up a **Streamable-HTTP** MCP endpoint behind TLS, so a judge
can connect their LLM without running anything locally. It authenticates each request with a
bearer token and serves the **same read-only tool set** — no order placement, ever.

```
POST https://<host>/mcp
Authorization: Bearer <read-only-token>
Content-Type: application/json
```

```jsonc
{
  "mcpServers": {
    "silver-lynx-remote": {
      "transport": { "type": "http", "url": "https://<host>/mcp" },
      "headers": { "Authorization": "Bearer <read-only-token>" }
    }
  }
}
```

The HTTP connector's code (stateless Streamable-HTTP transport, per-request token auth,
read-only tool surface) is staged in this submission but **not deployed** — a human flips it
live and fills in the host + token. The URL above is a placeholder until then.

---

## Evidence highlights

Captured artifacts backing the claims above (redacted per submission rules — no tickers,
account sizes, or P&L figures):

- **Real MCP orders.** Verbatim `[mcp-venue] ok buy …` log lines from a live cell — real
  multi-leg fills landing on Alpaca *through the MCP tool call*, with fill price and
  sub-300ms round-trip latency. The price staircase on one contract is the multi-leg fill plan
  resting inside the spread and walking the remainder, bounded above by the arrival ceiling.
- **The rising-ask invariant.** The execution test suite drives an ask *up 50% mid-fill* and
  asserts no recorded price on any path (rungs, walk, spray, sweep) ever crosses the
  arrival-anchored ceiling.
- **The decision journal.** 37,881 structured records; each buy carries the full chain — gate
  percentage, governor, contract / holding-period / quantity, execution mode and plan, and the
  AI's own size factor.
- **occ-symbol, live.** Dual-published to npm (`0.1.1`) and PyPI (`0.1.1`), zero runtime deps,
  byte-identical rounding across both ports, live docs at [occsymbol.com](https://occsymbol.com).

---

## What's in this repo

```
README.md          — this file
architecture.md    — the deep architecture write-up (ENG + TRADE lens)
LICENSE            — MIT
package.json       — runnable ESM package (npm install && npm test)
tsconfig.json      — strict TS config for typecheck
src/               — clean-room RUNNABLE reference modules (see src/README.md)
  risk-gauntlet.ts          — ~9 named, kill-switchable deterministic risk gates
  ai-overlay-guardrail.ts   — the veto/resize clamp + fail-open passthrough
  arrival-ceiling.ts        — the arrival-anchored price ceiling
  token-budget.ts           — two-tier compact-scalar projection under a hard cap
test/              — node --test suites (all green):
  arrival-ceiling.test.ts       — ask +50% mid-fill → no price crosses the ceiling
  ai-overlay-guardrail.test.ts  — clamp / veto / fail-open passthrough
  token-budget.test.ts          — under the char cap, key scalars preserved
scripts/           — journal-tally.ts (decision-journal audit tally)
data/              — decisions.sample.jsonl (SYNTHETIC sample journal — no tickers, no $)
examples/          — the original sanitized illustrative excerpts (intent, not runnable):
  ai-overlay-guardrail.ts   — the veto/resize clamp + fail-open passthrough
  execution-ceiling.ts      — the arrival-anchored price ceiling
  mcp-venue-call.ts         — placing a real order via Alpaca's MCP server
mcp-server/        — read-only HTTP MCP connector, SECURITY.md, .env.example
packages/          — occ-symbol/ (vendored public OSS OCC-symbol parser)
```

> **This is a curated public showcase.** The production agent lives in a private repository.
> The `src/` modules are **fresh clean-room reimplementations** of the open execution/risk layer —
> runnable and tested — while `examples/` holds the original sanitized excerpts that show the
> real code's *shape and intent*. Throughout, proprietary conviction-score vocabulary is genericized
> and tuned parameter values are replaced with named placeholders or generic thresholds. No alpha,
> no tickers, no account sizes, no P&L.

---

## License

MIT — see [`LICENSE`](./LICENSE).
