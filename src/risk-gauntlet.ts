/**
 * ── THE DETERMINISTIC RISK GAUNTLET (clean, runnable illustration) ────────────────────────────
 * A pipeline of named, individually kill-switchable, DETERMINISTIC gates. Every candidate clears
 * these BEFORE any LLM sees it — so zero model tokens and zero option-chain fetches are spent on
 * names that fail risk. Cheap scalar checks run first; each gate returns pass, or skip with a
 * named reason; each is a live env flag (default-on).
 *
 * "How the agent ran" is half an ops review. A pipeline where each control is a reversible switch
 * with a logged reason for every rejection is auditable in a way a monolithic prompt never is —
 * you can prove exactly WHY the agent passed on a name and flip any control off in seconds.
 *
 * This is a FRESH clean-room illustration for the public reference repo. The gates here are GENERIC
 * risk checks (spread width, liquidity, DTE window, per-name cap, exposure cap, etc.) with plain
 * thresholds — NO proprietary alpha, NO proprietary score names. The private engine's real gate set
 * and thresholds are not reproduced; the PATTERN — ordered, named, switchable, reason-logged — is.
 * Run `npm run risk-gauntlet:demo` for a worked example.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** A candidate contract + the world-safe context a deterministic gate needs to judge it. */
export interface Candidate {
  /** opaque symbol handle — NEVER a real ticker in this reference. */
  ref: string;
  /** days to expiration. */
  dte: number;
  /** bid/ask spread as a fraction of the ask, in [0, 1]. */
  spreadPct: number;
  /** open interest on the contract (liquidity proxy). */
  openInterest: number;
  /** the day's traded volume on the contract (liquidity proxy). */
  volume: number;
  /** generic conviction score in [0, 1] from the upstream signal desk (already bounded scalar). */
  conviction: number;
  /** proposed order notional as a fraction of account equity, in [0, 1]. */
  proposedNotionalPct: number;
}

/** World-safe portfolio context the gauntlet reads (all bounded scalars, no dollars). */
export interface PortfolioContext {
  /** fraction of equity already deployed to THIS underlying (per-name concentration). */
  existingNamePct: number;
  /** fraction of equity deployed across ALL open positions (gross exposure). */
  grossExposurePct: number;
  /** true if we already hold / recently entered this name (de-dup). */
  alreadyHeld: boolean;
  /** coarse market-regime block: true means "risk-off, no new entries". */
  regimeBlocked: boolean;
}

/** Tunable, world-safe thresholds. All plain execution/risk bounds — not alpha. */
export interface GauntletConfig {
  maxSpreadPct: number; // widest spread we'll cross
  dteMin: number; // shortest DTE we'll enter
  dteMax: number; // longest DTE we'll enter
  minOpenInterest: number; // liquidity floor
  minVolume: number; // liquidity floor
  minConviction: number; // generic conviction floor
  maxNamePct: number; // per-name concentration cap
  maxGrossExposurePct: number; // whole-book exposure cap
  maxOrderNotionalPct: number; // single-order size cap
}

export const DEFAULT_CONFIG: GauntletConfig = {
  maxSpreadPct: 0.15,
  dteMin: 7,
  dteMax: 45,
  minOpenInterest: 100,
  minVolume: 10,
  minConviction: 0.3,
  maxNamePct: 0.1,
  maxGrossExposurePct: 0.8,
  maxOrderNotionalPct: 0.05,
};

/** Which gates are ON. Every gate is individually kill-switchable — flip one to false to disable
 *  it without touching code (in prod these are env flags, default-on). */
export interface GauntletSwitches {
  regimeBlock: boolean;
  dedup: boolean;
  convictionFloor: boolean;
  dteWindow: boolean;
  spreadWidth: boolean;
  liquidity: boolean;
  perNameCap: boolean;
  orderSizeCap: boolean;
  grossExposureCap: boolean;
}

export const ALL_ON: GauntletSwitches = {
  regimeBlock: true,
  dedup: true,
  convictionFloor: true,
  dteWindow: true,
  spreadWidth: true,
  liquidity: true,
  perNameCap: true,
  orderSizeCap: true,
  grossExposureCap: true,
};

export type GateName = keyof GauntletSwitches;

/** One gate's verdict. A gate PASSES (candidate survives) or SKIPS with a named, logged reason. */
export type GateResult = { pass: true } | { pass: false; reason: string };

const pass: GateResult = { pass: true };
const skip = (reason: string): GateResult => ({ pass: false, reason });

/**
 * One gate = { name, enabled-check, verdict }. Ordered cheapest/most-severe FIRST so we bail before
 * doing expensive work on a name that fails risk. Each `run` is pure and deterministic.
 */
interface Gate {
  name: GateName;
  run(c: Candidate, p: PortfolioContext, cfg: GauntletConfig): GateResult;
}

/** The ordered pipeline. Cheap scalar / regime checks first; sizing/exposure caps last. */
export const GATES: readonly Gate[] = [
  {
    name: 'regimeBlock',
    run: (_c, p) => (p.regimeBlocked ? skip('regime-block: risk-off, no new entries') : pass),
  },
  {
    name: 'dedup',
    run: (_c, p) => (p.alreadyHeld ? skip('dedup: already hold / recently entered this name') : pass),
  },
  {
    name: 'convictionFloor',
    run: (c, _p, cfg) =>
      c.conviction < cfg.minConviction
        ? skip(`conviction-floor: ${c.conviction} < ${cfg.minConviction}`)
        : pass,
  },
  {
    name: 'dteWindow',
    run: (c, _p, cfg) =>
      c.dte < cfg.dteMin || c.dte > cfg.dteMax
        ? skip(`dte-window: ${c.dte} outside [${cfg.dteMin}, ${cfg.dteMax}]`)
        : pass,
  },
  {
    name: 'spreadWidth',
    run: (c, _p, cfg) =>
      c.spreadPct > cfg.maxSpreadPct
        ? skip(`spread-width: ${c.spreadPct} > ${cfg.maxSpreadPct}`)
        : pass,
  },
  {
    name: 'liquidity',
    run: (c, _p, cfg) => {
      if (c.openInterest < cfg.minOpenInterest) {
        return skip(`liquidity: OI ${c.openInterest} < ${cfg.minOpenInterest}`);
      }
      if (c.volume < cfg.minVolume) {
        return skip(`liquidity: vol ${c.volume} < ${cfg.minVolume}`);
      }
      return pass;
    },
  },
  {
    name: 'perNameCap',
    run: (c, p, cfg) =>
      p.existingNamePct + c.proposedNotionalPct > cfg.maxNamePct
        ? skip(
            `per-name-cap: ${round4(p.existingNamePct + c.proposedNotionalPct)} > ${cfg.maxNamePct}`,
          )
        : pass,
  },
  {
    name: 'orderSizeCap',
    run: (c, _p, cfg) =>
      c.proposedNotionalPct > cfg.maxOrderNotionalPct
        ? skip(`order-size-cap: ${c.proposedNotionalPct} > ${cfg.maxOrderNotionalPct}`)
        : pass,
  },
  {
    name: 'grossExposureCap',
    run: (c, p, cfg) =>
      p.grossExposurePct + c.proposedNotionalPct > cfg.maxGrossExposurePct
        ? skip(
            `gross-exposure-cap: ${round4(p.grossExposurePct + c.proposedNotionalPct)} > ${cfg.maxGrossExposurePct}`,
          )
        : pass,
  },
];

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** The outcome of running the whole gauntlet on one candidate. */
export interface GauntletVerdict {
  survived: boolean;
  /** the gate that stopped it, if any (the FIRST failing enabled gate). */
  failedGate?: GateName;
  reason?: string;
  /** every gate that ran, in order, with its result — the audit trail. */
  trail: Array<{ gate: GateName; enabled: boolean; result: GateResult }>;
}

/**
 * Run the gauntlet. Short-circuits at the FIRST failing enabled gate (that's the whole point — no
 * work past a rejection), but records the trail up to that point. A disabled gate is recorded as
 * skipped-because-off and does not block. A candidate that clears every enabled gate SURVIVES and
 * is what the (optional) LLM overlay would then see.
 */
export function runGauntlet(
  candidate: Candidate,
  portfolio: PortfolioContext,
  cfg: GauntletConfig = DEFAULT_CONFIG,
  switches: GauntletSwitches = ALL_ON,
): GauntletVerdict {
  const trail: GauntletVerdict['trail'] = [];
  for (const gate of GATES) {
    const enabled = switches[gate.name];
    if (!enabled) {
      trail.push({ gate: gate.name, enabled: false, result: pass });
      continue;
    }
    const result = gate.run(candidate, portfolio, cfg);
    trail.push({ gate: gate.name, enabled: true, result });
    if (!result.pass) {
      return { survived: false, failedGate: gate.name, reason: result.reason, trail };
    }
  }
  return { survived: true, trail };
}

// ── Tiny demo (run with `npm run risk-gauntlet:demo`) ───────────────────────────────────────────

function runDemo(): void {
  const portfolio: PortfolioContext = {
    existingNamePct: 0.02,
    grossExposurePct: 0.35,
    alreadyHeld: false,
    regimeBlocked: false,
  };

  const cases: Array<{ label: string; c: Candidate }> = [
    {
      label: 'clean survivor',
      c: {
        ref: 'sym-ax91q',
        dte: 21,
        spreadPct: 0.04,
        openInterest: 1200,
        volume: 300,
        conviction: 0.71,
        proposedNotionalPct: 0.03,
      },
    },
    {
      label: 'too-wide spread',
      c: {
        ref: 'sym-bt42p',
        dte: 14,
        spreadPct: 0.22,
        openInterest: 800,
        volume: 120,
        conviction: 0.66,
        proposedNotionalPct: 0.03,
      },
    },
    {
      label: 'concentration breach',
      c: {
        ref: 'sym-cq08r',
        dte: 30,
        spreadPct: 0.05,
        openInterest: 2000,
        volume: 500,
        conviction: 0.8,
        proposedNotionalPct: 0.09,
      },
    },
  ];

  // eslint-disable-next-line no-console
  console.log('── risk-gauntlet demo ─────────────────────────────────────');
  for (const { label, c } of cases) {
    const v = runGauntlet(c, portfolio);
    const outcome = v.survived ? 'SURVIVED → LLM overlay' : `SKIP @ ${v.failedGate}: ${v.reason}`;
    console.log(`${label.padEnd(24)} ${outcome}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDemo();
}
