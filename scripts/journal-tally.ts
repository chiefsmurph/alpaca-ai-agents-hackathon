/**
 * ── DECISION-JOURNAL TALLY (runnable audit script) ───────────────────────────────────────────
 * The AI-value claim isn't "trust us" — it's "here's the audit." Every candidate the agent
 * evaluates is appended as one JSON line to a decision journal. This script reads that journal and
 * prints the AI-overlay footprint: how often the model UPSIZED, DOWNSIZED, VETOED, or passed a gated
 * trade through at gate size — plus the median size factor.
 *
 * Because the AI can only act inside the guardrail clamp [0, 2×] (see src/ai-overlay-guardrail.ts),
 * its footprint is FULLY SEPARABLE from the deterministic strategy: filter to `action: 'buy'` records
 * and every `sizeFactor` is exactly the AI's modification to the gate's original size.
 *
 * Reads a SANITIZED, obviously-synthetic sample journal by default (data/decisions.sample.jsonl):
 * made-up records, NO real tickers (symbol is a `<contract>` placeholder), NO dollar figures. Point
 * it at your own journal with a path arg:  npm run journal-tally -- path/to/decisions.jsonl
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** One decision-journal record (the world-safe, sanitized subset). */
export interface DecisionRecord {
  ts: string;
  action: 'buy' | 'skip' | 'hold' | 'close' | string;
  executed: boolean;
  reason: string;
  gatePct: number | null;
  dte: number | null;
  qty: number | null;
  /** the AI overlay's resize factor: 0 = veto, <1 = downsize, 1 = passthrough, >1 = upsize. */
  sizeFactor: number | null;
  symbol?: string;
}

/** Parse a JSONL journal into records, tolerating blank lines and skipping unparseable ones. */
export function parseJournal(text: string): DecisionRecord[] {
  const out: DecisionRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as DecisionRecord);
    } catch {
      // A single corrupt line never sinks the whole audit.
    }
  }
  return out;
}

export interface Tally {
  total: number;
  buys: number;
  skips: number;
  /** buys the AI made bigger than the gate (sizeFactor > 1). */
  upsized: number;
  /** buys the AI made smaller than the gate (0 < sizeFactor < 1). */
  downsized: number;
  /** buys the AI vetoed (sizeFactor === 0). */
  vetoed: number;
  /** buys the AI passed through at gate size (sizeFactor === 1). */
  heldAtGate: number;
  /** median sizeFactor across all buy records that carry one. */
  medianSizeFactor: number | null;
  /** skip reasons, tallied. */
  skipReasons: Record<string, number>;
}

/** Median of a numeric array (null if empty). */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
  return Math.round(m * 1000) / 1000;
}

/** Compute the AI-overlay audit tally from parsed records. */
export function tally(records: DecisionRecord[]): Tally {
  const skipReasons: Record<string, number> = {};
  const sizeFactors: number[] = [];
  let buys = 0;
  let skips = 0;
  let upsized = 0;
  let downsized = 0;
  let vetoed = 0;
  let heldAtGate = 0;

  for (const r of records) {
    if (r.action === 'buy') {
      buys += 1;
      if (typeof r.sizeFactor === 'number') {
        sizeFactors.push(r.sizeFactor);
        if (r.sizeFactor === 0) vetoed += 1;
        else if (r.sizeFactor > 1) upsized += 1;
        else if (r.sizeFactor < 1) downsized += 1;
        else heldAtGate += 1;
      }
    } else if (r.action === 'skip') {
      skips += 1;
      const reason = r.reason || '(no reason)';
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    }
  }

  return {
    total: records.length,
    buys,
    skips,
    upsized,
    downsized,
    vetoed,
    heldAtGate,
    medianSizeFactor: median(sizeFactors),
    skipReasons,
  };
}

/** Pretty-print the tally. */
function printTally(t: Tally, source: string): void {
  const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(0)}%` : '—');
  // eslint-disable-next-line no-console
  const log = console.log;
  log('── decision-journal audit tally ───────────────────────────────');
  log(`source:              ${source}`);
  log(`total decisions:     ${t.total}`);
  log(`  buys:              ${t.buys}`);
  log(`  skips:             ${t.skips}`);
  log('');
  log('AI-overlay footprint (on buy candidates):');
  log(`  upsized (>1×):     ${t.upsized}  (${pct(t.upsized, t.buys)})`);
  log(`  held at gate (=1×):${String(t.heldAtGate).padStart(2)}  (${pct(t.heldAtGate, t.buys)})`);
  log(`  downsized (<1×):   ${t.downsized}  (${pct(t.downsized, t.buys)})`);
  log(`  vetoed (=0×):      ${t.vetoed}  (${pct(t.vetoed, t.buys)})`);
  log(`  median sizeFactor: ${t.medianSizeFactor ?? '—'}`);
  log('');
  log('skip reasons:');
  const reasons = Object.entries(t.skipReasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length === 0) log('  (none)');
  for (const [reason, n] of reasons) log(`  ${String(n).padStart(3)}  ${reason}`);
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultPath = resolve(here, '..', 'data', 'decisions.sample.jsonl');
  const path = process.argv[2] ? resolve(process.argv[2]) : defaultPath;

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`could not read journal at ${path}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const records = parseJournal(text);
  printTally(tally(records), path);
}

// ESM entry-point guard: run only when executed directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
