# `src/` — runnable reference modules

Clean-room, self-contained reimplementations of the agent's **open execution & risk layer**. These
are fresh illustrations written for this public repo — the private engine's ladder math, proprietary
score names, and tuned thresholds are **not** reproduced. Every module here is exercised by a passing
test under [`../test/`](../test/).

| Module | What it is | Backed by |
|--------|------------|-----------|
| [`risk-gauntlet.ts`](./risk-gauntlet.ts) | A pipeline of ~9 named, individually kill-switchable deterministic risk gates (spread width, liquidity, DTE window, per-name cap, exposure cap, …). Each returns pass or skip+reason; the first failing enabled gate short-circuits. | demo: `npm run risk-gauntlet:demo` |
| [`ai-overlay-guardrail.ts`](./ai-overlay-guardrail.ts) | The bounded AI overlay: clamp a model's untrusted output to a veto (size 0) or a resize in `[0, 2×]`, sanitize the multi-leg fill plan, and **fail open** at gate size on any error. | [`../test/ai-overlay-guardrail.test.ts`](../test/ai-overlay-guardrail.test.ts) |
| [`arrival-ceiling.ts`](./arrival-ceiling.ts) | The arrival-anchored dollar ceiling: resolve one cap once, clamp **every** produced venue price through it, so a rising ask can't be chased across rungs, walk steps, spray shots, and sweeps. | [`../test/arrival-ceiling.test.ts`](../test/arrival-ceiling.test.ts) |
| [`token-budget.ts`](./token-budget.ts) | Two-tier compaction: project a big nested position down to a few curated + opportunistic scalars under a hard char cap (the ~30× cost reduction). | [`../test/token-budget.test.ts`](../test/token-budget.test.ts) · demo: `npm run token-budget:demo` |

Everything here illustrates the **execution/risk layer** — never the upstream alpha.
