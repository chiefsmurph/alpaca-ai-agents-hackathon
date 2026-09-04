import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  guardrail,
  decideOne,
  sanitizePlan,
  DEFAULT_MAX_SIZE_UP,
  type LlmCandidate,
} from '../src/ai-overlay-guardrail.ts';

const CAND: LlmCandidate = {
  underlying: 'SPY',
  contract: 'SPY260825C00500000',
  dte: 21,
  ask: 1.25,
  spot: 500,
};

test('resize is clamped to [0, maxSizeUp]: a model returning sizeFactor 5 is clamped to the max', () => {
  const d = guardrail({ verdict: 'approve', sizeFactor: 5, reason: 'very high conviction' });
  assert.equal(d.verdict, 'approve');
  assert.equal(d.sizeFactor, DEFAULT_MAX_SIZE_UP); // clamped down from 5 to 2
});

test('resize honors a valid in-range factor', () => {
  const d = guardrail({ verdict: 'approve', sizeFactor: 1.5, reason: 'ok' });
  assert.equal(d.sizeFactor, 1.5);
});

test('a negative sizeFactor is floored to 0', () => {
  const d = guardrail({ verdict: 'approve', sizeFactor: -3, reason: 'nope' });
  assert.equal(d.sizeFactor, 0);
});

test('a reject → size 0 (veto), regardless of any sizeFactor the model sent', () => {
  const d = guardrail({ verdict: 'reject', sizeFactor: 2, reason: 'too risky' });
  assert.equal(d.verdict, 'reject');
  assert.equal(d.sizeFactor, 0);
});

test('anything other than an explicit "approve" is treated as a reject (fail safe)', () => {
  for (const bad of [{ verdict: 'maybe' }, { verdict: 'APPROVE' }, { verdict: 'yes' }, {}]) {
    const d = guardrail(bad);
    assert.equal(d.verdict, 'reject', `verdict ${JSON.stringify(bad)} should be treated as reject`);
    assert.equal(d.sizeFactor, 0);
  }
});

test('a malformed / non-object response coerces to a safe reject (size 0), not a crash', () => {
  for (const bad of [null, undefined, 42, 'oops', []]) {
    const d = guardrail(bad);
    assert.equal(d.verdict, 'reject');
    assert.equal(d.sizeFactor, 0);
  }
});

test('a NaN / non-numeric sizeFactor on an approve coerces to 0', () => {
  assert.equal(guardrail({ verdict: 'approve', sizeFactor: Number.NaN }).sizeFactor, 0);
  assert.equal(guardrail({ verdict: 'approve', sizeFactor: 'lots' }).sizeFactor, 0);
});

test('execMode falls back to the default when invalid', () => {
  const d = guardrail({ verdict: 'approve', sizeFactor: 1, execMode: 'YOLO' }, 2, 'walk');
  assert.equal(d.execMode, 'walk');
  const ok = guardrail({ verdict: 'approve', sizeFactor: 1, execMode: 'spray' }, 2, 'walk');
  assert.equal(ok.execMode, 'spray');
});

test('execPlan is sanitized: bad legs dropped, fractions clamped to [0,1], capped at 4 legs', () => {
  const plan = sanitizePlan([
    { mode: 'immediate', qtyPct: 1, lowFrac: -1, highFrac: 5 }, // fractions clamp to 0 and 1
    { mode: 'bogus', qtyPct: 1 }, // dropped: invalid mode
    { mode: 'walk', qtyPct: 0 }, // dropped: non-positive weight
    { mode: 'between', qtyPct: 2, lowFrac: 0.8, highFrac: 0.2 }, // low>high → reordered
    { mode: 'spray', qtyPct: 1 },
    { mode: 'spray', qtyPct: 1 }, // 5th valid — capped out (max 4 legs kept from the sliced input)
  ]);
  assert.ok(plan, 'expected a sanitized plan');
  for (const leg of plan!) {
    if (leg.lowFrac !== undefined) assert.ok(leg.lowFrac >= 0 && leg.lowFrac <= 1);
    if (leg.highFrac !== undefined) assert.ok(leg.highFrac >= 0 && leg.highFrac <= 1);
    if (leg.lowFrac !== undefined && leg.highFrac !== undefined) {
      assert.ok(leg.lowFrac <= leg.highFrac, 'low must be <= high');
    }
  }
  // the invalid-mode + zero-weight legs must be gone
  assert.ok(!plan!.some((l) => (l.mode as string) === 'bogus'));
  assert.ok(plan!.length <= 4);
});

test('a reject drops any execPlan (it sizes to 0 anyway)', () => {
  const d = guardrail({
    verdict: 'reject',
    sizeFactor: 0,
    execPlan: [{ mode: 'walk', qtyPct: 1 }],
  });
  assert.equal(d.execPlan, undefined);
});

// ── decideOne fail-open behavior ────────────────────────────────────────────────────────────────

test('decideOne: a thrown error fails OPEN — passthrough approval at gate size', async () => {
  const d = await decideOne(CAND, async () => {
    throw new Error('network timeout');
  });
  assert.equal(d.verdict, 'approve');
  assert.equal(d.sizeFactor, 1); // gate size — strategy keeps trading
  assert.match(d.reason, /passthrough/);
});

test('decideOne: a null raw (no tool call / refusal) fails OPEN — passthrough at gate size', async () => {
  const d = await decideOne(CAND, async () => null);
  assert.equal(d.verdict, 'approve');
  assert.equal(d.sizeFactor, 1);
  assert.match(d.reason, /passthrough/);
});

test('decideOne: a genuine well-formed reject STILL vetoes (only errors pass open)', async () => {
  const d = await decideOne(CAND, async () => ({ verdict: 'reject', reason: 'thin liquidity' }));
  assert.equal(d.verdict, 'reject');
  assert.equal(d.sizeFactor, 0);
});

test('decideOne: a valid approve+resize flows through the guardrail clamp', async () => {
  const d = await decideOne(CAND, async () => ({ verdict: 'approve', sizeFactor: 9, reason: 'x' }));
  assert.equal(d.verdict, 'approve');
  assert.equal(d.sizeFactor, DEFAULT_MAX_SIZE_UP); // clamped
});
