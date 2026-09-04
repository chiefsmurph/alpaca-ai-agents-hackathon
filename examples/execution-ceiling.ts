/**
 * ── ILLUSTRATIVE EXCERPT (sanitized) ────────────────────────────────────────────────────────
 * The arrival-anchored price ceiling: the fill engine PHYSICALLY CANNOT chase a rising ask.
 *
 * The subtlety this kills: every execution mode prices as a FRACTION of the live bid→ask spread.
 * A fraction ≤ 1.0 is "at or below the ask" — but the ask itself can climb in DOLLARS while the
 * order works. So "don't bid above the ask" is not enough; we anchor ONE absolute dollar ceiling
 * to the ARRIVAL quote at run start and clamp EVERY venue price through it — resting rungs, walk
 * steps, spray shots, and both the timeout and ensure-fill sweeps.
 *
 * A multi-leg plan shares ONE ceiling anchored to the plan's arrival, so a later leg can never
 * re-anchor to a risen ask.
 *
 * Sanitized for the public showcase: mode bodies are elided to show the invariant, not the ladder
 * math. The chase ceiling itself is not secret — it defaults to 10% (`arrival_ask × 1.10`) and is a
 * plain, tunable execution parameter, not alpha. A test in the private repo drives the ask UP 50%
 * mid-execution and asserts no recorded price on any path crosses `ceiling`.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** How far above the arrival ask we will ever pay, as a fraction. DEFAULT: 0.10 (a 10% ceiling,
 *  i.e. `arrival_ask × 1.10`) — read from config so a desk can tune it. The point is that it is a
 *  HARD cap resolved ONCE at run start, not re-quoted per fill. */
const MAX_CHASE_PCT = config.maxChasePct; // default 0.10

/**
 * Effective absolute ceiling for a run: an explicit override wins; otherwise anchor to the
 * ARRIVAL ask × (1 + maxChasePct). Non-finite/non-positive results collapse to +Infinity (NO
 * ceiling) so a bad quote never turns the ceiling into 0/NaN and silently blocks every fill.
 */
function resolveCeiling(arrivalAsk: number, maxChasePct: number, override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
  const pct = Number.isFinite(maxChasePct) && maxChasePct >= 0 ? maxChasePct : DEFAULT_CHASE_PCT;
  const c = round2(arrivalAsk * (1 + pct));
  return Number.isFinite(c) && c > 0 ? c : Infinity;
}

/**
 * Every mode receives the SAME clamp closure. `capToCeiling` is the single choke-point: no price
 * reaches the venue without passing through it.
 */
function buildModeCtx(spread: Spread, params: BuyParams): ModeCtx {
  // Anchor ONCE, at run start, to the arrival ask.
  const ceiling = resolveCeiling(spread.ask, MAX_CHASE_PCT, params.maxLimitPrice);
  const capToCeiling = (p: number) => Math.min(p, ceiling);
  return { ...params, spread, ceiling, capToCeiling };
}

// ── How each mode uses it (representative; other modes clamp identically) ──────────────────────

/** immediate — one limit at the cap fraction of the spread, clamped to the ceiling. */
async function runImmediate(ctx: ModeCtx): Promise<void> {
  const { spread, capToCeiling } = ctx;
  const capFrac = clamp01(ctx.priceFrac?.high, 1);
  const limit = capToCeiling(priceAtFrac(spread.bid, spread.ask, capFrac));
  //             ^^^^^^^^^^^^  even at fraction 1.0 ("the ask"), a risen ask is clamped down.
  await ctx.venue.placeLimitBuy(ctx.occSymbol, ctx.qty, limit);
}

/** timeout / ensure-fill sweep — re-quotes may have RISEN; clamp so the sweep can't chase up. */
async function sweep(ctx: ModeCtx, live: Spread): Promise<void> {
  // `live` may be a RISEN re-quote — clamp to the arrival-anchored ceiling.
  const sweepLimit = ctx.capToCeiling(priceAtFrac(live.bid, live.ask, ctx.sweepFrac));
  await ctx.venue.placeLimitBuy(ctx.occSymbol, ctx.remainingQty, sweepLimit);
}

/**
 * Multi-leg plan: resolve the ceiling ONCE from the plan's arrival and pass the SAME clamp to
 * every leg — a later leg cannot re-anchor to a risen ask.
 */
async function executePlan(plan: ExecLeg[], arrival: Spread, p: BuyParams): Promise<void> {
  const ceiling = resolveCeiling(arrival?.ask ?? 0, MAX_CHASE_PCT, p.maxLimitPrice);
  const capToCeiling = (price: number) => Math.min(price, ceiling);
  for (const leg of plan) {
    await runLeg(leg, { ...p, ceiling, capToCeiling });
  }
}

// ── Types / helpers referenced above (shapes only; bodies elided in this excerpt) ──────────────
interface Spread { bid: number; ask: number }
interface ExecLeg { mode: string; qtyPct: number; lowFrac?: number; highFrac?: number }
interface BuyParams { occSymbol: string; qty: number; priceFrac?: { high?: number }; maxLimitPrice?: number; sweepFrac?: number; remainingQty?: number; venue: Venue }
interface Venue { placeLimitBuy(sym: string, qty: number, limit: number): Promise<unknown> }
interface ModeCtx extends BuyParams { spread: Spread; ceiling: number; capToCeiling: (p: number) => number }
declare const config: { maxChasePct: number };
declare const DEFAULT_CHASE_PCT: number;
declare function round2(n: number): number;
declare function clamp01(v: number | undefined, dflt: number): number;
declare function priceAtFrac(bid: number, ask: number, frac: number): number;
declare function runLeg(leg: ExecLeg, ctx: Partial<ModeCtx>): Promise<void>;
