# Illustrative code excerpts

These files are **sanitized, illustrative excerpts** from the private production agent. They show
the *shape and intent* of the load-bearing safety mechanisms. They will not compile standalone:
types and helpers whose bodies don't matter to the point are declared and elided.

> **Want the runnable version?** The same patterns are reimplemented as clean, self-contained,
> **runnable** modules under [`../src/`](../src/) with passing tests under [`../test/`](../test/).
> Run `npm install && npm test`. Use these `examples/` files to read the *intent* quickly; use
> `src/` to actually execute and test the mechanism.

Sanitization applied throughout:
- proprietary conviction-score vocabulary is **genericized** ("conviction score," "hold-tier,"
  "market-regime context");
- **alpha-bearing config is omitted** (the proprietary feed-signal projection, conviction
  thresholds, per-cell presets). The two plain **execution bounds** shown here are *not* alpha and
  are disclosed as their defaults: the AI resize clamp is **[0, 2×]** (`MAX_SIZE_UP` default 2) and
  the arrival-chase ceiling is **10%** (`MAX_CHASE_PCT` default 0.10) — both read from config so a
  desk can tune them;
- no tickers, account sizes, or P&L figures.

| Excerpt | Runnable counterpart | The idea it shows |
|---------|----------------------|-------------------|
| [`ai-overlay-guardrail.ts`](./ai-overlay-guardrail.ts) | [`../src/ai-overlay-guardrail.ts`](../src/ai-overlay-guardrail.ts) | The bounded AI overlay: a forced tool-call, the veto/resize clamp `[0, MAX_SIZE_UP]`, the `[0,1]` leg-price clamp, and the fail-open passthrough. |
| [`execution-ceiling.ts`](./execution-ceiling.ts) | [`../src/arrival-ceiling.ts`](../src/arrival-ceiling.ts) | The arrival-anchored dollar ceiling: one cap resolved once and applied to every venue price, so a rising ask can't be chased. |
| [`mcp-venue-call.ts`](./mcp-venue-call.ts) | *(illustrative only — needs the live MCP SDK + Alpaca creds)* | Placing a real order as a client of Alpaca's official MCP server, with the `connect`/`transport`/`rejected` failure classification that decides whether to fall back to REST. |
