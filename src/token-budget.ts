/**
 * ── TWO-TIER TOKEN BUDGET — THE COMPACT-SCALAR PROJECTION (clean, runnable illustration) ──────
 * One raw upstream feed position carries the engine's full internal state as deeply nested objects
 * — tens of thousands of characters each. Serializing one whole into a prompt burned real money
 * fast against a hard prepaid cap. This step projects it down to a few compact SCALARS under a
 * strict character budget — roughly 30× cheaper per call, and the model sees MORE structured signal.
 *
 * Two tiers:
 *   1. Curated (Tier 1) — a fixed whitelist of scalars, always sent when present.
 *   2. Opportunistic (Tier 2) — any OTHER small scalar the feed sends, added until the char budget
 *      is hit. Nested objects, arrays, and long strings — the bloat source — are ALWAYS excluded.
 *
 * A hard char cap is the final backstop: a future schema change can never blow up per-call cost.
 *
 * This is a FRESH clean-room illustration for the public reference repo. The Tier-1 whitelist here
 * uses GENERIC, world-safe field names (conviction / holdTier / regime flags) — the private engine's
 * real proprietary score names are NOT reproduced. The mechanism (whitelist → opportunistic fill →
 * hard cap) is the point. `test/token-budget.test.ts` asserts the output stays under the cap and
 * preserves the key scalars. Run `npm run token-budget:demo` for a raw-vs-compacted size print.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Hard character budget for one compacted position. The final backstop against a schema change
 *  blowing up per-call cost. Tunable per model tier. */
export const DEFAULT_CHAR_BUDGET = 600;

/** Longest string value we'll ever keep — anything longer is bloat and is dropped. */
const MAX_STR_LEN = 32;

/**
 * Tier-1 curated whitelist: GENERIC, world-safe scalar names always kept when present. These span
 * both what a gate/sizing step reads and signals the model might weigh itself. (In the private
 * engine these map to proprietary score names via a closed config; here they are neutral labels.)
 */
export const CURATED_KEYS: readonly string[] = [
  'ref', // opaque symbol handle (never the ticker)
  'conviction', // generic conviction score
  'holdTier', // generic hold-tier bucket
  'regime', // generic market-regime context
  'dte', // days to expiration
  'spreadPct', // bid/ask spread as a fraction
  'ivRank', // implied-vol rank
  'trend', // coarse trend sign
];

/** A raw feed position: an arbitrarily deep, wide bag of state. */
export type RawPosition = Record<string, unknown>;

/** A compacted position: flat scalars only. */
export type CompactPosition = Record<string, number | string | boolean>;

/** Is this a small, safe SCALAR we're willing to put in a prompt? Numbers, booleans, and short
 *  strings only — never objects, arrays, functions, or long strings (the bloat sources). */
function isCompactScalar(v: unknown): v is number | string | boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return true;
  if (typeof v === 'string') return v.length <= MAX_STR_LEN;
  return false;
}

/** Round a number to a few significant places so scalars don't carry noise digits (cost + clarity). */
function tidy(v: number | string | boolean): number | string | boolean {
  if (typeof v !== 'number') return v;
  if (Number.isInteger(v)) return v;
  return Math.round(v * 10000) / 10000;
}

/**
 * Project ONE raw position to a compact scalar view under a hard char budget.
 *
 * 1. Tier 1: copy every curated key that is present AND a compact scalar.
 * 2. Tier 2: walk the remaining top-level keys in a stable order, adding each compact scalar only
 *    while the serialized result stays under `charBudget`.
 * 3. Nested objects / arrays / long strings are NEVER included, at any tier.
 */
export function compactPosition(
  raw: RawPosition,
  charBudget = DEFAULT_CHAR_BUDGET,
): CompactPosition {
  const out: CompactPosition = {};

  // Tier 1 — curated whitelist, always kept when present + scalar.
  for (const key of CURATED_KEYS) {
    const v = raw[key];
    if (isCompactScalar(v)) out[key] = tidy(v);
  }

  // Tier 2 — opportunistic fill of OTHER scalars, in stable (sorted) key order, until the budget.
  const curated = new Set(CURATED_KEYS);
  const extraKeys = Object.keys(raw)
    .filter((k) => !curated.has(k))
    .sort();

  for (const key of extraKeys) {
    const v = raw[key];
    if (!isCompactScalar(v)) continue; // drops nested objects/arrays/long strings — the bloat.
    const candidate = { ...out, [key]: tidy(v) };
    if (JSON.stringify(candidate).length <= charBudget) {
      out[key] = tidy(v);
    }
    // else: keep going — a later key might be small enough to still fit.
  }

  // Final backstop: if even the curated tier somehow overflows, trim from the end of insertion
  // order until we are under the cap. Should be rare, but the cap is a HARD guarantee.
  let keys = Object.keys(out);
  while (JSON.stringify(out).length > charBudget && keys.length > 0) {
    const drop = keys[keys.length - 1];
    if (drop === undefined) break;
    delete out[drop];
    keys = Object.keys(out);
  }

  return out;
}

/** Compact a whole feed (array of raw positions) — the shape the prompt builder consumes. */
export function compactFeed(
  raw: RawPosition[],
  charBudget = DEFAULT_CHAR_BUDGET,
): CompactPosition[] {
  return raw.map((p) => compactPosition(p, charBudget));
}

/** Serialized character size of a value — the thing we're actually paying for per call. */
export function charSize(value: unknown): number {
  return JSON.stringify(value).length;
}

// ── Tiny demo: raw size vs compacted size (run with `npm run token-budget:demo`) ────────────────

/** Build one obviously-synthetic, deeply-nested raw position to show the before/after. NO real
 *  tickers or proprietary vocabulary — generic scalars plus a big nested-state bag as the bloat. */
function makeSyntheticRawPosition(): RawPosition {
  const bigNestedState: Record<string, unknown> = {};
  for (let i = 0; i < 40; i += 1) {
    bigNestedState[`window_${i}`] = {
      samples: Array.from({ length: 24 }, (_, j) => Math.round((j + i) * 13.7) / 10),
      note: 'internal rolling-window state the model never needs and must not pay for',
    };
  }
  return {
    // Tier-1 scalars the model actually wants:
    ref: 'sym-ax91q',
    conviction: 0.7412,
    holdTier: 3,
    regime: 'range',
    dte: 21,
    spreadPct: 0.037,
    ivRank: 0.58,
    trend: 1,
    // A few Tier-2 scalars:
    updatedMinAgo: 2,
    quoteAgeMs: 350,
    // The bloat: deeply nested internal state + long strings + arrays (all excluded).
    internalState: bigNestedState,
    debugTrace: 'x'.repeat(5000),
    rawTicks: Array.from({ length: 500 }, (_, i) => i * 0.5),
  };
}

function runDemo(): void {
  const raw = makeSyntheticRawPosition();
  const compact = compactPosition(raw);
  const rawSize = charSize(raw);
  const compactSize = charSize(compact);
  const ratio = (rawSize / Math.max(1, compactSize)).toFixed(1);

  // eslint-disable-next-line no-console
  console.log('── token-budget demo (synthetic position) ─────────────────');
  console.log(`raw serialized chars:      ${rawSize.toLocaleString()}`);
  console.log(`compacted chars:           ${compactSize.toLocaleString()} (budget ${DEFAULT_CHAR_BUDGET})`);
  console.log(`reduction:                 ~${ratio}× smaller`);
  console.log('compacted view (what the model sees):');
  console.log(JSON.stringify(compact, null, 2));
}

// ESM entry-point guard: only run the demo when executed directly, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  runDemo();
}
