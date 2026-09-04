import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactPosition,
  compactFeed,
  charSize,
  CURATED_KEYS,
  DEFAULT_CHAR_BUDGET,
  type RawPosition,
} from '../src/token-budget.ts';

/** Build an obviously-synthetic, deeply-nested raw position — the "bloat" the projection strips.
 *  NO real tickers, NO proprietary vocabulary. */
function makeRaw(): RawPosition {
  const bigNested: Record<string, unknown> = {};
  for (let i = 0; i < 50; i += 1) {
    bigNested[`w${i}`] = { samples: Array.from({ length: 30 }, (_, j) => (i + j) * 1.1) };
  }
  return {
    // Tier-1 curated scalars we MUST preserve:
    ref: 'sym-ax91q',
    conviction: 0.7412,
    holdTier: 3,
    regime: 'range',
    dte: 21,
    spreadPct: 0.037,
    ivRank: 0.58,
    trend: 1,
    // Tier-2 opportunistic scalars:
    updatedMinAgo: 2,
    quoteAgeMs: 350,
    // Bloat — nested objects, arrays, long strings — MUST be excluded:
    internalState: bigNested,
    debugTrace: 'z'.repeat(8000),
    rawTicks: Array.from({ length: 400 }, (_, i) => i * 0.25),
  };
}

test('compacted output is under the hard char budget', () => {
  const compact = compactPosition(makeRaw());
  assert.ok(
    charSize(compact) <= DEFAULT_CHAR_BUDGET,
    `compacted size ${charSize(compact)} exceeded budget ${DEFAULT_CHAR_BUDGET}`,
  );
});

test('a tiny custom budget is still respected as a hard cap', () => {
  const compact = compactPosition(makeRaw(), 120);
  assert.ok(charSize(compact) <= 120, `size ${charSize(compact)} exceeded custom budget 120`);
});

test('the key curated scalars are preserved', () => {
  const compact = compactPosition(makeRaw());
  // the important gate/sizing scalars survive:
  assert.equal(compact.ref, 'sym-ax91q');
  assert.equal(compact.holdTier, 3);
  assert.equal(compact.dte, 21);
  assert.equal(compact.regime, 'range');
  assert.equal(compact.trend, 1);
  // numeric scalars are preserved (tidied, but equal here / close)
  assert.equal(compact.conviction, 0.7412);
  assert.equal(compact.spreadPct, 0.037);
  assert.equal(compact.ivRank, 0.58);
});

test('nested objects, arrays, and long strings are ALWAYS excluded (the bloat)', () => {
  const compact = compactPosition(makeRaw());
  assert.equal(compact.internalState, undefined, 'nested object must be dropped');
  assert.equal(compact.rawTicks, undefined, 'array must be dropped');
  assert.equal(compact.debugTrace, undefined, 'long string must be dropped');
  // every surviving value is a compact scalar
  for (const v of Object.values(compact)) {
    const t = typeof v;
    assert.ok(t === 'number' || t === 'string' || t === 'boolean', `non-scalar survived: ${t}`);
    if (t === 'string') assert.ok((v as string).length <= 32, 'string longer than cap survived');
  }
});

test('the projection achieves a large size reduction (the ~30× cost claim, directionally)', () => {
  const raw = makeRaw();
  const compact = compactPosition(raw);
  const ratio = charSize(raw) / charSize(compact);
  assert.ok(ratio > 20, `expected a big reduction, got ${ratio.toFixed(1)}×`);
});

test('curated keys that are present are all scalars and get whitelisted', () => {
  const raw: RawPosition = {};
  for (const k of CURATED_KEYS) raw[k] = k === 'ref' || k === 'regime' ? 'x' : 1;
  const compact = compactPosition(raw);
  for (const k of CURATED_KEYS) {
    assert.ok(k in compact, `curated key ${k} should be present`);
  }
});

test('compactFeed maps a whole feed and each entry respects the budget', () => {
  const feed = compactFeed([makeRaw(), makeRaw(), makeRaw()]);
  assert.equal(feed.length, 3);
  for (const p of feed) {
    assert.ok(charSize(p) <= DEFAULT_CHAR_BUDGET);
    assert.equal(p.ref, 'sym-ax91q');
  }
});

test('a malformed raw (non-scalar curated values) does not throw and drops bad values', () => {
  const raw: RawPosition = {
    ref: 'sym-ax91q',
    conviction: { nested: true }, // not a scalar — must be dropped, not crash
    holdTier: 2,
  };
  const compact = compactPosition(raw);
  assert.equal(compact.ref, 'sym-ax91q');
  assert.equal(compact.holdTier, 2);
  assert.equal(compact.conviction, undefined);
});
