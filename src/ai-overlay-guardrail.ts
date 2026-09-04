/**
 * ── BOUNDED AI OVERLAY — THE SAFETY BOUNDARY (clean, runnable illustration) ───────────────────
 * This is what makes an LLM safe to run on live capital: it sits ON TOP of a deterministic gate
 * that has ALREADY approved each candidate, and the model's (untrusted) output is clamped in code —
 * nothing downstream ever consumes a raw model decision.
 *
 * Two moves only:
 *   - verdict 'reject'   → sizeFactor forced to 0                    (veto)
 *   - verdict 'approve'  → sizeFactor clamped to [0, MAX_SIZE_UP]    (resize; can never widen a gate)
 *
 * FAILS OPEN: on any infra error, timeout, or a response with no usable tool-call, the overlay
 * returns a PASSTHROUGH approval at gate size — the proven deterministic strategy keeps trading
 * instead of going dark. (A genuine, well-formed model 'reject' still vetoes; only errors pass.)
 *
 * This is a FRESH clean-room illustration for the public reference repo — the real feed-signal
 * projection (which names proprietary conviction scores) is omitted. The resize ceiling itself is
 * not secret: it DEFAULTS to 2× (the clamp is [0, 2×]); a plain execution bound, not alpha.
 * `test/ai-overlay-guardrail.test.ts` exercises the clamp, the veto, and the fail-open passthrough.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Default resize ceiling. The model may size an already-gated trade DOWN to 0 or UP to this
 *  multiple — small on purpose so the AI can express conviction without inventing risk. */
export const DEFAULT_MAX_SIZE_UP = 2;

export type ExecMode = 'immediate' | 'between' | 'walk' | 'spray';
export const EXEC_MODES: readonly ExecMode[] = ['immediate', 'between', 'walk', 'spray'];

export interface ExecLeg {
  mode: ExecMode;
  qtyPct: number;
  lowFrac?: number;
  highFrac?: number;
}

export interface LlmDecision {
  verdict: 'approve' | 'reject';
  sizeFactor: number;
  execMode: ExecMode;
  execPlan?: ExecLeg[];
  reason: string;
}

/** Fail-open decision: approve at gate size (sizeFactor 1) with the configured exec mode. Used when
 *  the overlay can't produce a trustworthy verdict (infra error or no tool call) — NEVER on a real
 *  model reject. The deterministic gate has ALREADY approved this candidate. */
export function passthrough(execMode: ExecMode, reason: string): LlmDecision {
  return { verdict: 'approve', sizeFactor: 1, execMode, reason: reason.slice(0, 200) };
}

/** Coerce a value to a spread fraction in [0, 1], or undefined if not a finite number. */
function toFrac(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
}

/**
 * Sanitize the model's (untrusted) execPlan into safe legs, or undefined if there's nothing usable
 * (→ caller falls back to the single execMode). Drops legs with an invalid mode or non-positive
 * weight, CLAMPS every fraction to [0, 1] (the ≤-ask guarantee), orders low ≤ high, caps at 4 legs.
 */
export function sanitizePlan(raw: unknown): ExecLeg[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const legs: ExecLeg[] = [];
  for (const item of raw.slice(0, 4)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const mode = o.mode;
    if (typeof mode !== 'string' || !(EXEC_MODES as readonly string[]).includes(mode)) continue;
    const qtyPct = typeof o.qtyPct === 'number' ? o.qtyPct : Number(o.qtyPct);
    if (!Number.isFinite(qtyPct) || qtyPct <= 0) continue;

    let low = toFrac(o.lowFrac);
    let high = toFrac(o.highFrac);
    if (low !== undefined && high !== undefined && low > high) [low, high] = [high, low];

    legs.push({
      mode: mode as ExecMode,
      qtyPct,
      ...(low !== undefined ? { lowFrac: low } : {}),
      ...(high !== undefined ? { highFrac: high } : {}),
    });
  }
  return legs.length ? normalizeWeights(legs) : undefined;
}

/** Normalize leg weights so the recorded plan is tidy (sums to 1). Pure presentation — the price
 *  safety comes from the [0,1] fraction clamp above, not from the weights. */
function normalizeWeights(legs: ExecLeg[]): ExecLeg[] {
  const total = legs.reduce((s, l) => s + l.qtyPct, 0);
  if (!(total > 0)) return legs;
  return legs.map((l) => ({ ...l, qtyPct: Math.round((l.qtyPct / total) * 1000) / 1000 }));
}

/**
 * Enforce guardrails on the model's (untrusted) output. THIS is the safety boundary — nothing
 * downstream should ever consume a raw model decision.
 *
 * - verdict: anything other than an explicit 'approve' is treated as a reject (fail safe).
 * - sizeFactor: coerced, then CLAMPED to [0, maxSizeUp]; a reject overrides to exactly 0.
 * - execMode: must be a real ExecMode, else falls back to the caller's default.
 * - execPlan: only kept on an approve, sanitized to valid legs with fractions clamped to [0,1].
 */
export function guardrail(
  raw: unknown,
  maxSizeUp = DEFAULT_MAX_SIZE_UP,
  defaultExecMode: ExecMode = 'immediate',
): LlmDecision {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const verdict: 'approve' | 'reject' = obj.verdict === 'approve' ? 'approve' : 'reject';

  const rawMode = obj.execMode;
  const execMode: ExecMode =
    typeof rawMode === 'string' && (EXEC_MODES as readonly string[]).includes(rawMode)
      ? (rawMode as ExecMode)
      : defaultExecMode;

  let sizeFactor: number;
  if (verdict === 'reject') {
    sizeFactor = 0;
  } else {
    const n = typeof obj.sizeFactor === 'number' ? obj.sizeFactor : Number(obj.sizeFactor);
    const safe = Number.isFinite(n) ? n : 0;
    sizeFactor = Math.min(Math.max(safe, 0), maxSizeUp);
  }

  const reason =
    typeof obj.reason === 'string' && obj.reason.trim()
      ? obj.reason.trim().slice(0, 300)
      : '(no reason given)';

  const execPlan = verdict === 'approve' ? sanitizePlan(obj.execPlan) : undefined;

  return { verdict, sizeFactor, execMode, reason, ...(execPlan ? { execPlan } : {}) };
}

// ── The LLM call seam (illustrative) ───────────────────────────────────────────────────────────
// The real overlay forces a single tool-call (`tool_choice: {type:'tool', name:'submit_decision'}`)
// so the model cannot free-text its way past the guardrail, reads structured output off the tool_use
// block, and runs the batch fanned out concurrently. The provider client and prompt-building are
// omitted from this public illustration; the load-bearing part — the guardrail + fail-open — is
// above and fully tested. This wrapper shows the shape: parse → guardrail, and fail OPEN on error.

export interface LlmCandidate {
  underlying: string;
  contract: string;
  dte: number;
  ask: number;
  spot: number;
  /* + genericized signal scalars (conviction score, hold-tier, market-regime context) */
}

/** Something that produces a raw decision object for one candidate (a forced tool-call in prod). */
export type DecideRaw = (cand: LlmCandidate) => Promise<unknown>;

/**
 * One candidate → one guarded decision. On any failure — thrown error, or a null/undefined raw
 * (refusal / truncation / no tool call) — we PASS THROUGH at gate size rather than block an
 * already-gated trade on the overlay's health.
 */
export async function decideOne(
  cand: LlmCandidate,
  decideRaw: DecideRaw,
  maxSizeUp = DEFAULT_MAX_SIZE_UP,
  defaultExecMode: ExecMode = 'immediate',
): Promise<LlmDecision> {
  try {
    const raw = await decideRaw(cand);
    if (raw == null) return passthrough(defaultExecMode, 'llm-no-decision (passthrough)');
    return guardrail(raw, maxSizeUp, defaultExecMode);
  } catch (err) {
    // FAIL OPEN — the deterministic gate has ALREADY approved this candidate. An infra problem
    // (network, auth, timeout, rate limit) must not halt entries; let it through at gate size.
    const detail = err instanceof Error ? err.message : String(err);
    return passthrough(defaultExecMode, `llm-error (passthrough): ${detail}`);
  }
}
