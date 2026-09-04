import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModeCtx,
  executePlan,
  resolveCeiling,
  runLeg,
  sweep,
  priceAtFrac,
  DEFAULT_CHASE_PCT,
  type ExecLeg,
  type Spread,
  type Venue,
} from '../src/arrival-ceiling.ts';

/** A fake venue whose ask RISES on every quote — simulating a fast-moving contract that keeps
 *  climbing while our order works. Records every limit price we ever tried to send. */
function makeRisingVenue(start: Spread, riseFactor: number) {
  const prices: number[] = [];
  let current: Spread = { ...start };
  return {
    /** Every quote is 1 + riseFactor higher than the last — the ask keeps climbing. */
    quote(): Spread {
      current = {
        bid: round2(current.bid * (1 + riseFactor)),
        ask: round2(current.ask * (1 + riseFactor)),
      };
      return current;
    },
    venue: {
      placeLimitBuy(_sym: string, _qty: number, limitPrice: number): void {
        prices.push(limitPrice);
      },
    } satisfies Venue,
    prices,
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

test('resolveCeiling anchors to arrival ask × (1 + chasePct)', () => {
  assert.equal(resolveCeiling(1.0, 0.1), 1.1);
  assert.equal(resolveCeiling(2.0, DEFAULT_CHASE_PCT), 2.2);
  // an explicit override wins
  assert.equal(resolveCeiling(2.0, 0.1, 3.0), 3.0);
  // a bad quote never collapses the ceiling to 0/NaN — it becomes +Infinity (no ceiling)
  assert.equal(resolveCeiling(0, 0.1), Infinity);
  assert.equal(resolveCeiling(Number.NaN, 0.1), Infinity);
});

test('single leg: a 50%-risen ask never produces a price above the arrival ceiling', async () => {
  const arrival: Spread = { bid: 0.9, ask: 1.0 }; // arrival ask 1.00
  const chasePct = 0.1;
  const ceiling = resolveCeiling(arrival.ask, chasePct); // 1.10

  // Ask rises 50% on the very next quote (1.00 → 1.50), way past the 1.10 ceiling.
  const rising = makeRisingVenue(arrival, 0.5);
  const ctx = buildModeCtx(arrival, {
    occSymbol: 'SPY260825C00500000',
    qty: 10,
    venue: rising.venue,
    maxChasePct: chasePct,
  });

  // Work an aggressive "immediate at the ask" leg against the RISEN quote.
  const leg: ExecLeg = { mode: 'immediate', qtyPct: 1, lowFrac: 1, highFrac: 1 };
  await runLeg(ctx, leg, rising.quote());

  assert.ok(rising.prices.length > 0, 'expected at least one produced price');
  for (const p of rising.prices) {
    assert.ok(p <= ceiling, `produced price ${p} exceeded ceiling ${ceiling}`);
  }
});

test('every mode + sweep stays under the ceiling as the ask keeps climbing', async () => {
  const arrival: Spread = { bid: 1.9, ask: 2.0 }; // arrival ask 2.00
  const chasePct = 0.1;
  const ceiling = resolveCeiling(arrival.ask, chasePct); // 2.20

  const rising = makeRisingVenue(arrival, 0.5); // +50% each quote — runs far past the ceiling
  const ctx = buildModeCtx(arrival, {
    occSymbol: 'SPY260825C00500000',
    qty: 12,
    venue: rising.venue,
    maxChasePct: chasePct,
  });

  const legs: ExecLeg[] = [
    { mode: 'immediate', qtyPct: 1, lowFrac: 0.5, highFrac: 1 },
    { mode: 'between', qtyPct: 1, lowFrac: 0.3, highFrac: 0.9 },
    { mode: 'walk', qtyPct: 1, lowFrac: 0.2, highFrac: 1 },
    { mode: 'spray', qtyPct: 1, lowFrac: 0.8, highFrac: 1 },
  ];
  for (const leg of legs) {
    await runLeg(ctx, leg, rising.quote());
  }
  // and the ensure-fill sweep against a further-risen quote
  await sweep(ctx, rising.quote(), 12);

  assert.ok(rising.prices.length >= 12, 'expected many produced prices across modes + sweep');
  for (const p of rising.prices) {
    assert.ok(p <= ceiling, `produced price ${p} exceeded ceiling ${ceiling}`);
  }
  // and at least one price should have HIT the ceiling (proving the clamp actually bit)
  assert.ok(
    rising.prices.some((p) => p === ceiling),
    'expected the clamp to bind at the ceiling on a risen ask',
  );
});

test('multi-leg plan shares ONE ceiling — a later leg cannot re-anchor to a risen ask', async () => {
  const arrival: Spread = { bid: 0.95, ask: 1.0 };
  const chasePct = 0.1;
  const ceiling = resolveCeiling(arrival.ask, chasePct); // 1.10

  const rising = makeRisingVenue(arrival, 0.5);
  const plan: ExecLeg[] = [
    { mode: 'immediate', qtyPct: 0.5, lowFrac: 1, highFrac: 1 },
    { mode: 'immediate', qtyPct: 0.5, lowFrac: 1, highFrac: 1 }, // later leg — must NOT re-anchor
  ];

  const { ceiling: usedCeiling } = await executePlan(
    plan,
    arrival,
    { occSymbol: 'SPY260825C00500000', qty: 10, venue: rising.venue, maxChasePct: chasePct },
    () => rising.quote(),
  );

  assert.equal(usedCeiling, ceiling, 'plan must anchor ONE ceiling to arrival');
  for (const p of rising.prices) {
    assert.ok(p <= ceiling, `leg produced ${p} above the shared ceiling ${ceiling}`);
  }
});

test('priceAtFrac interpolates the spread and never exceeds the ask', () => {
  assert.equal(priceAtFrac(1.0, 2.0, 0), 1.0);
  assert.equal(priceAtFrac(1.0, 2.0, 1), 2.0);
  assert.equal(priceAtFrac(1.0, 2.0, 0.5), 1.5);
  // fractions are clamped to [0,1] so even a bogus 5 can't exceed the ask
  assert.equal(priceAtFrac(1.0, 2.0, 5), 2.0);
});
