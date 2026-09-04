/**
 * ── ARRIVAL-ANCHORED PRICE CEILING (clean, runnable illustration) ────────────────────────────
 * The fill engine PHYSICALLY CANNOT chase a rising ask.
 *
 * The subtlety this kills: every execution mode prices as a FRACTION of the live bid→ask spread.
 * A fraction ≤ 1.0 is "at or below the ask" — but the ask itself can climb in DOLLARS while the
 * order works. So "don't bid above the ask" is not enough. We anchor ONE absolute dollar ceiling
 * to the ARRIVAL quote at run start and clamp EVERY produced venue price through it — resting
 * rungs, walk steps, spray shots, and the timeout / ensure-fill sweeps alike.
 *
 * A multi-leg plan shares ONE ceiling anchored to the plan's arrival, so a later leg can never
 * re-anchor to a risen ask.
 *
 * This is a FRESH clean-room illustration written for the public reference repo — the ladder math
 * of the private engine is not reproduced; the CEILING INVARIANT is. The chase ceiling itself is
 * not secret: it defaults to 10% (`arrivalAsk × 1.10`) and is a plain, tunable execution bound,
 * not alpha. `test/arrival-ceiling.test.ts` drives the ask UP 50% mid-fill and asserts no recorded
 * price on ANY path ever crosses the ceiling.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** How far above the arrival ask we will ever pay, as a fraction. DEFAULT: 0.10 (a 10% ceiling,
 *  i.e. `arrivalAsk × 1.10`). A HARD cap resolved ONCE at run start, not re-quoted per fill. */
export const DEFAULT_CHASE_PCT = 0.1;

export interface Spread {
  bid: number;
  ask: number;
}

/** A single execution tactic. Each prices as a fraction of the live spread; the ceiling is applied
 *  on top so a risen ask can never lift the produced price past the arrival anchor. */
export type ExecMode = 'immediate' | 'between' | 'walk' | 'spray';

export interface ExecLeg {
  mode: ExecMode;
  /** portion of remaining qty this leg works, in (0, 1]. */
  qtyPct: number;
  /** low fraction of the spread this leg is willing to pay, in [0, 1]. */
  lowFrac?: number;
  /** high fraction of the spread this leg is willing to pay, in [0, 1]. */
  highFrac?: number;
}

/** A minimal venue seam: something that records the limit price we would send. The real engine
 *  calls Alpaca; here we capture every produced price so a test can assert the invariant. */
export interface Venue {
  placeLimitBuy(occSymbol: string, qty: number, limitPrice: number): void | Promise<void>;
}

export interface BuyParams {
  occSymbol: string;
  qty: number;
  venue: Venue;
  /** explicit hard ceiling override; wins over the arrival-derived one when finite and > 0. */
  maxLimitPrice?: number;
  /** chase fraction; defaults to DEFAULT_CHASE_PCT. */
  maxChasePct?: number;
}

/** Round to cents, the granularity a venue actually accepts. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Coerce a value to a spread fraction in [0, 1]; falls back to `dflt` on a non-finite input. */
export function clamp01(v: number | undefined, dflt: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(0, Math.min(1, n));
}

/** Price at a fraction of the bid→ask spread. frac 0 → bid, frac 1 → ask. */
export function priceAtFrac(bid: number, ask: number, frac: number): number {
  const f = Math.max(0, Math.min(1, frac));
  return round2(bid + (ask - bid) * f);
}

/**
 * Effective absolute ceiling for a run: an explicit override wins; otherwise anchor to the ARRIVAL
 * ask × (1 + maxChasePct). Non-finite / non-positive results collapse to +Infinity (NO ceiling) so
 * a bad quote never turns the ceiling into 0/NaN and silently blocks every fill.
 */
export function resolveCeiling(arrivalAsk: number, maxChasePct: number, override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
  const pct = Number.isFinite(maxChasePct) && maxChasePct >= 0 ? maxChasePct : DEFAULT_CHASE_PCT;
  const c = round2(arrivalAsk * (1 + pct));
  return Number.isFinite(c) && c > 0 ? c : Infinity;
}

interface ModeCtx {
  spread: Spread;
  ceiling: number;
  capToCeiling: (p: number) => number;
  venue: Venue;
  occSymbol: string;
  qty: number;
}

/**
 * Build the shared mode context. `capToCeiling` is the SINGLE choke-point: no price reaches the
 * venue without passing through it. The ceiling is anchored ONCE here, to the arrival ask.
 */
export function buildModeCtx(arrival: Spread, params: BuyParams): ModeCtx {
  const ceiling = resolveCeiling(
    arrival.ask,
    params.maxChasePct ?? DEFAULT_CHASE_PCT,
    params.maxLimitPrice,
  );
  const capToCeiling = (p: number) => Math.min(p, ceiling);
  return {
    spread: arrival,
    ceiling,
    capToCeiling,
    venue: params.venue,
    occSymbol: params.occSymbol,
    qty: params.qty,
  };
}

/**
 * Execute one leg against the LIVE spread. `live` may be a RISEN re-quote — every produced price is
 * clamped through the arrival-anchored ceiling, so no rung can chase the ask up in dollars.
 */
export async function runLeg(ctx: ModeCtx, leg: ExecLeg, live: Spread): Promise<void> {
  const legQty = Math.max(1, Math.round(ctx.qty * clamp01(leg.qtyPct, 1)));
  const low = clamp01(leg.lowFrac, 0);
  const high = clamp01(leg.highFrac, 1);
  const [lo, hi] = low <= high ? [low, high] : [high, low];

  switch (leg.mode) {
    case 'immediate': {
      // One shot at the high fraction of the LIVE spread, clamped to the ceiling.
      const limit = ctx.capToCeiling(priceAtFrac(live.bid, live.ask, hi));
      await ctx.venue.placeLimitBuy(ctx.occSymbol, legQty, limit);
      return;
    }
    case 'between': {
      // Rest inside the spread at a couple of rungs; each clamped.
      for (const f of [lo, (lo + hi) / 2, hi]) {
        const limit = ctx.capToCeiling(priceAtFrac(live.bid, live.ask, f));
        await ctx.venue.placeLimitBuy(ctx.occSymbol, legQty, limit);
      }
      return;
    }
    case 'walk': {
      // Walk from low to high across the spread; each step clamped.
      const steps = 4;
      for (let i = 0; i <= steps; i += 1) {
        const f = lo + ((hi - lo) * i) / steps;
        const limit = ctx.capToCeiling(priceAtFrac(live.bid, live.ask, f));
        await ctx.venue.placeLimitBuy(ctx.occSymbol, legQty, limit);
      }
      return;
    }
    case 'spray': {
      // Fire several small shots at the high fraction; each clamped.
      for (let i = 0; i < 3; i += 1) {
        const limit = ctx.capToCeiling(priceAtFrac(live.bid, live.ask, hi));
        await ctx.venue.placeLimitBuy(ctx.occSymbol, legQty, limit);
      }
      return;
    }
  }
}

/**
 * The timeout / ensure-fill sweep. `live` may be a RISEN re-quote — clamp so the sweep can't chase
 * price up either. Sweeps at the ceiling-capped ask.
 */
export async function sweep(ctx: ModeCtx, live: Spread, remainingQty: number): Promise<void> {
  const sweepLimit = ctx.capToCeiling(priceAtFrac(live.bid, live.ask, 1));
  await ctx.venue.placeLimitBuy(ctx.occSymbol, remainingQty, sweepLimit);
}

/**
 * Execute a multi-leg plan. The ceiling is resolved ONCE from the plan's arrival and the SAME clamp
 * is threaded into every leg — a later leg cannot re-anchor to a risen ask. `quote()` returns the
 * live (possibly-risen) spread each time it is called.
 */
export async function executePlan(
  plan: ExecLeg[],
  arrival: Spread,
  params: BuyParams,
  quote: () => Spread,
): Promise<{ ceiling: number }> {
  const ctx = buildModeCtx(arrival, params);
  for (const leg of plan.slice(0, 4)) {
    await runLeg(ctx, leg, quote());
  }
  // Ensure-fill sweep against a fresh (possibly risen) quote — still ceiling-bounded.
  await sweep(ctx, quote(), ctx.qty);
  return { ceiling: ctx.ceiling };
}
