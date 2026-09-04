# Silver Lynx — Architecture

A tour of the execution-and-risk desk. Each section carries an **[ENG]** line for software
engineers and a **[TRADE]** line for traders — every technical claim earns a "why a trader
cares," and every trader claim is grounded in the architecture.

> **Scope note.** This document describes the *open* agent — the part under evaluation. The
> upstream proprietary research engine (the signal desk) is a separate system, not in this repo.
> All proprietary conviction-score vocabulary below is genericized ("conviction score,"
> "hold-tier," "market-regime context"), and tuned parameter values are shown as named
> placeholders — the point is the shape, not the config.

---

## 0. The two-desk split

```
  proprietary research engine  ──(one typed, read-only socket)──▶  Silver Lynx
  (signal desk — a black box)      bounded scalars only            (execution & risk — open)
```

**[ENG]** The entire upstream engine is consumed through a *single* module: it subscribes to one
event and exposes a handful of read-only getters returning a typed DTO of bounded scalars. There
is no shared code, no RPC into the engine's internals, and — deliberately — no write-back path.
The agent's *entire input* is a few named getters returning bounded numbers and enums; the
separation is enforced by architecture, not by a promise.

**[TRADE]** This is how a real quant shop is organized: a signals desk that guards its edge, an
execution-and-risk desk that is auditable and accountable. Judges can inspect 100% of the desk
that touches the market while the alpha stays a black box. The strongest answer to "how do we
know the real logic isn't hidden in the agent?" is that the agent never *has* the logic — only
its bounded outputs.

---

## 1. The deterministic risk gauntlet (runs first, runs cheapest)

**[ENG]** Roughly ten individually kill-switchable gates run in **cost/severity order**:

```
market-regime hard block
   → re-entry de-duplication
   → conviction floor (proprietary hold-score ≥ threshold)
   → overnight-eligibility
   → position gate (per-name presence)
   → falling-knife pre-gate
   → spot / chain / spread checks
   → [ the LLM overlay sees ONLY the survivors ]
   → quality-factor & cumulative concentration caps
```

Cheap scalar checks run first, so **zero LLM tokens and zero option-chain fetches** are spent on
names that fail risk. Every gate is a documented environment flag (default-on), and every skip
is journaled with a structured reason.

**[TRADE]** "How the agent ran" is half the score. A pipeline where each control is a reversible
switch with a logged reason for every rejection is auditable in a way a single monolithic prompt
never is — you can prove exactly *why* the agent passed on a name and flip any control off in
seconds. That operational maturity is what a desk demands before real capital.

---

## 2. The bounded AI overlay

**[ENG]** The overlay runs *after* the deterministic gate has already approved a candidate. Each
candidate becomes one **forced tool-call** (`tool_choice: {type:'tool', name:'submit_decision'}`)
with `max_tokens` capped and the batch fanned out concurrently. The model can return exactly two
outcomes, and **guardrails are enforced in code after the model returns** — nothing downstream
ever consumes a raw model decision:

- `verdict: 'reject'` → `sizeFactor` forced to `0` (veto).
- `verdict: 'approve'` → `sizeFactor` coerced and **clamped to `[0, maxSizeUp]`** (a small
  configurable ceiling). It can never widen a gate.
- `execMode` / `execPlan` → validated; an invalid plan falls back to a safe single mode.

It **fails open**: on any infra error, timeout, or a response with no usable tool-call, the
overlay returns a *passthrough approval at gate size* — the proven strategy keeps trading.

See [`examples/ai-overlay-guardrail.ts`](./examples/ai-overlay-guardrail.ts).

**[TRADE]** A trader's nightmare is an LLM inventing new risk. Here the AI is bounded on *both*
sides — it can only make an already-cleared trade smaller (to zero) or up to a small multiple,
and the deterministic gate is always the floor. If the model goes down mid-session, the desk
keeps trading instead of going dark. That's the line between a demo and something you'd run with
real money.

---

## 3. Token discipline — the two-tier compact-scalar projection

**[ENG]** Each raw upstream feed position carries the engine's full internal state as nested
objects — **tens of thousands of tokens each**. Serializing one whole into a prompt burned real
money fast against a hard prepaid cap. A compaction step projects it to a compact **scalar** view
in two tiers:

1. **Curated (Tier 1)** — a fixed whitelist of scalars, always sent when present. Spans both
   what the gate/sizing reads *and* meaningful signals the agent doesn't use itself but the model
   might.
2. **Opportunistic (Tier 2)** — any *other* small scalar the feed sends, added until a character
   budget is hit.

Nested objects, arrays, and long strings — the bloat source — are *always* excluded, and the
whole prompt is hard-capped as a final backstop so a future schema change can never blow up cost.

**[TRADE]** Real token-cost engineering under a hard prepaid cap, born from a real incident:
compact prompts cost a fraction of a cent per call versus the raw dumps — **roughly 30× cheaper
and more structured**. Per-decision inference cost is a bounded, tunable knob — exactly how you'd
productionize an LLM-in-the-loop trader under a budget.

---

## 4. Composable multi-leg fill plans

**[ENG]** The model may return a fill plan of one to four legs, combining `immediate`, `between`
(rest across the spread), `walk`, and `spray` tactics — each leg's price expressed as a
**fraction of the live bid→ask spread**. A sanitizer drops invalid legs, **clamps every fraction
to `[0, 1]`**, orders low ≤ high, caps at four legs, and normalizes the weights. The `[0, 1]`
clamp is the hard mathematical guarantee that no leg ever prices above the ask.

**[TRADE]** On thin, wide-spread short-dated contracts, *how* you enter matters as much as
*whether*. The AI can rest most of the order inside the spread and walk a backstop — execution
nuance a fixed mode can't express — while the clamp makes the classic LLM failure of chasing
price above the ask structurally impossible.

---

## 5. Arrival-anchored execution — the fill engine cannot chase a rising ask

**[ENG]** At the start of a fill the engine resolves **one absolute dollar ceiling** from the
arrival quote (`arrivalAsk × (1 + maxChasePct)`) and clamps *every* venue price through it —
resting rungs, walk steps, spray shots, timeout sweeps, and the ensure-fill sweep alike. A
multi-leg plan shares **one** ceiling anchored to the plan's arrival, so a later leg can't
re-anchor to a risen ask. The subtlety it kills: modes price as *fractions of the live spread*,
so a fraction ≤ 1.0 can still climb in *dollars* when the ask moves — the ceiling turns "don't
chase" into a hard invariant. A dedicated test drives the ask up 50% mid-execution and asserts no
recorded price on any path ever crosses the ceiling.

See [`examples/execution-ceiling.ts`](./examples/execution-ceiling.ts).

**[TRADE]** This is transaction-cost alpha — the discipline that separates a paper backtest from
a real fill. On a fast-decaying short-dated option, a missed contract is cheaper than a bad fill.
The engine's stated preference — *prefer an under-fill to overpaying* — is exactly how a
professional desk thinks about entering a thin, wide-spread market.

---

## 6. MCP-native execution, both directions

**[ENG]** Silver Lynx places real orders as a **client** of Alpaca's official MCP server: it
spawns the server over stdio and calls `place_option_order`. MCP is the **default venue** — you
opt out per instance with an env flag. A single execution seam funnels every order through it, and
arg shapes are verified against the live server schema (strings for qty/limit price, `type` not
`order_type`, day-only TIF for options, `client_order_id` preserved for attribution). Failures are
**classified** — `connect` / `transport` / `rejected` — so an infra break is handled *oppositely*
from an order rejection: a transport error falls back to REST (the order provably never reached the
exchange), while a `rejected` order is *never* retried (double-fill risk).

See [`examples/mcp-venue-call.ts`](./examples/mcp-venue-call.ts).

The agent *also exposes its own* read-only MCP server (inspection tools only) so a grader's LLM
can connect, inspect live account and position state, and query the decision journal — without
any ability to mutate.

**[TRADE]** For an AI-agents event this is the thesis made literal: the agent doesn't just call a
REST endpoint, it drives orders through the same Model Context Protocol an LLM tool-use agent
would use — so "the agent actually ran" is provable at the venue layer, and the read-only server
lets a judge watch it reason over live state safely. "My infra died" and "the market said no" are
handled oppositely — the difference between resilient and either silently-losing-trades or
accidentally-doubling-size.

---

## 7. The decision journal — every decision a queryable JSON line

**[ENG]** Every decision appends one JSON object to `decisions.jsonl` plus an in-memory ring:
`{ts, phase, symbol, action, executed, reason}` and phase context. A buy record captures the full
chain — gate percentage, governor, contract / holding-period / quantity / cost, execution mode and
plan, quality factor, and **the AI's own size factor**. All journal writes are wrapped so a disk
hiccup can never touch the trading path, and the journal is exposed live through the read-only MCP
tool `slq_get_decisions`.

**[TRADE]** "Record *why* a trade was taken" is the headline explainability feature top entries
brag about — here it's first-class, machine-queryable, and demo-ready. A judge can pull the exact
reason the agent skipped or sized a trade, with the gate percentage, governor, and the AI's size
factor attached — a full audit trail from signal to fill, and trivial P&L attribution by reason
class. It is also the **primary evidence for the AI-value claim**: filter to the flagship's
interventions and replay every veto and resize against the gate's original call.

---

## 8. Curved capital deployment

**[ENG]** Rather than deploying the full book at the open, a two-segment power curve scales
capital in through a pivot — reserving dry powder early, catching up later, reaching full
deployment by a configured minute — and each cycle fills only a fraction of the remaining *gap* to
the curve target. Tests assert the early-session allowed fraction and per-cycle budget stay well
under the full allocation.

**[TRADE]** Dumping the whole book at the open pays the day's widest spreads and highest implied
vol. Averaging in on a curve is textbook execution-risk management: you keep dry powder for the
intraday dip and never let one bad open define the day. It reads like a systematic fund's
deployment schedule, not a "signal → market order" bot.

---

## 9. Supervised 24/7 run-loop with a fail-CLOSED kickoff gate

**[ENG]** One long-lived process connects the feed once, then loops. Entries are gated on Alpaca's
market clock; management (exits) *always* runs regardless. The kickoff/trading-window gate is
enforced at **two layers** — the loop skip *and* every order chokepoint — and is **fail-closed**:
an unparseable trading-start config blocks *all* trading rather than accidentally trading the
overnight gap. Startup reconciliation cancels orphaned resting orders so stale rungs can't freeze
buying power. Feed state persists via atomic tmp+rename and rehydrates only if recent.

**[TRADE]** A market-timing gate that fails *open* on a config typo is how you trade the overnight
gap by accident. Fail-closed plus two enforcement layers is belt-and-suspenders against the single
most expensive class of agent bug — real ops maturity, not a demo.

---

## 10. Fleet & oversight

**[ENG]** The same code runs as multiple isolated instances — each pointed at its own env and data
directory, each stamping a per-instance `client_order_id` so attribution stays clean on a shared
feed. The live-money fleet is monitored **read-only** by a *separate* product whose config holds
the account with a read-only flag: the monitor is structurally incapable of placing an order.

**[TRADE]** Separation of concerns a real desk runs: the execution agents and the oversight
dashboard are different processes with different permissions — watching the fleet can't touch it.

---

## Model & cost

**[ENG]** The model tier is a single env var — a capable default, dial-downable to a cheaper tier
per cell. One forced tool-call per candidate, small token cap, fanned out concurrently. A
pricing-aware cost model ships alongside so per-decision cost is projectable.

**[TRADE]** A judge or ops team can dial the intelligence/cost tradeoff per cell with no code
change — run the strongest model where the thesis is being proven, drop a high-throughput cell to
a cheaper tier. Per-decision AI cost is a tunable knob, exactly how you'd productionize an
LLM-in-the-loop trader under a budget.

---

## Open-source plumbing — occ-symbol

**[ENG]** A zero-dependency OCC/OSI option-symbol parser, dual-published to
[npm](https://www.npmjs.com/package/occ-symbol) and [PyPI](https://pypi.org/project/occ-symbol/).
The two ports are kept byte-identical: the Python side reimplements JavaScript's half-away-from-zero
rounding because Python's built-in `round()` uses banker's rounding and would disagree on exact
half-thousandth strikes. Live docs at [occsymbol.com](https://occsymbol.com).

**[TRADE]** Option tickers are a notorious source of silent, money-losing bugs — a mis-parsed
strike routes an order to the wrong contract. A round-trip-tested, broker-agnostic parser is the
boring-but-critical plumbing that keeps an options agent from fat-fingering a leg, and shipping it
as OSS signals a team that treats correctness as first-class.
