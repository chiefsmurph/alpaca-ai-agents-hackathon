/**
 * ── ILLUSTRATIVE EXCERPT (sanitized) ────────────────────────────────────────────────────────
 * The bounded AI overlay's SAFETY BOUNDARY. This is what makes the LLM safe to run on live
 * capital: it sits ON TOP of a deterministic gate that has ALREADY approved each candidate, and
 * the model's (untrusted) output is clamped in code — nothing downstream ever consumes a raw
 * model decision.
 *
 * Two moves only:
 *   - verdict 'reject'   → sizeFactor forced to 0            (veto)
 *   - verdict 'approve'  → sizeFactor clamped to [0, MAX_SIZE_UP]   (resize; can never widen a gate)
 *
 * FAILS OPEN: on any infra error, timeout, or a response with no usable tool-call, the overlay
 * returns a PASSTHROUGH approval at gate size — the proven deterministic strategy keeps trading
 * instead of going dark. (A genuine, well-formed model 'reject' still vetoes; only errors pass.)
 *
 * Sanitized for the public showcase: the real feed-signal projection (which names proprietary
 * conviction scores) is omitted. The resize ceiling itself is not secret — it DEFAULTS to 2× (the
 * clamp is [0, 2×]); it is a plain execution bound, not alpha.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Configurable resize ceiling. DEFAULT: 2 (clamp is [0, 2×]). The model may size an already-gated
 *  trade DOWN to 0 or UP to this multiple — small on purpose so the AI can express conviction
 *  without inventing risk. Read from config so a desk can tune it. */
const MAX_SIZE_UP = CONFIG.maxSizeUp; // default 2

type ExecMode = 'immediate' | 'between' | 'walk' | 'spray';
const EXEC_MODES: readonly ExecMode[] = ['immediate', 'between', 'walk', 'spray'];

interface LlmDecision {
  verdict: 'approve' | 'reject';
  sizeFactor: number;
  execMode: ExecMode;
  execPlan?: ExecLeg[];
  reason: string;
}

/** One candidate → one forced tool-call. The model MUST call submit_decision; we read structured
 *  output off its tool_use block. On any failure we pass through — never block a gated trade on the
 *  overlay's health. */
async function decideOne(
  cand: LlmCandidate,
  ctx: LlmContext,
  client: LlmClient,
  model: string,
  defaultExecMode: ExecMode,
): Promise<LlmDecision> {
  try {
    const message = await client.messages.create({
      model,
      max_tokens: MAX_DECISION_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [{ name: 'submit_decision', description: TOOL_DESCRIPTION, input_schema: INPUT_SCHEMA }],
      // FORCE the tool-call: the model cannot free-text its way past the guardrail.
      tool_choice: { type: 'tool', name: 'submit_decision' },
      messages: [{ role: 'user', content: buildUserContent(cand, ctx) }],
    });

    const raw = extractToolInput(message);
    // No usable tool call (refusal/truncation) → don't block an already-gated trade on it.
    if (raw == null) return passthrough(defaultExecMode, 'llm-no-decision (passthrough)');
    return guardrail(raw, MAX_SIZE_UP, defaultExecMode);
  } catch (err) {
    // FAIL OPEN — the deterministic gate has ALREADY approved this candidate. If the overlay is
    // unreachable/misconfigured (network, auth, timeout, rate limit), let the trade through at gate
    // size rather than halting entries on an infra problem. The overlay is an ENHANCER that can
    // veto/resize strong setups — NOT a hard dependency the whole strategy stalls without.
    const detail = err instanceof Error ? err.message : String(err);
    return passthrough(defaultExecMode, `llm-error (passthrough): ${detail}`);
  }
}

/** Fail-open decision: approve at gate size with the configured exec mode. Used when the overlay
 *  can't produce a trustworthy verdict (infra error or no tool call) — NEVER on a real model reject. */
function passthrough(execMode: ExecMode, reason: string): LlmDecision {
  return { verdict: 'approve', sizeFactor: 1, execMode, reason: reason.slice(0, 200) };
}

/**
 * Enforce guardrails on the model's (untrusted) output. THIS is the safety boundary — nothing
 * downstream should ever consume a raw model decision.
 */
export function guardrail(raw: unknown, maxSizeUp: number, defaultExecMode: ExecMode): LlmDecision {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  // verdict: anything other than an explicit 'approve' is treated as a reject (fail safe).
  const verdict: 'approve' | 'reject' = obj.verdict === 'approve' ? 'approve' : 'reject';

  // execMode: must be a real ExecMode, else fall back to the configured default.
  const rawMode = obj.execMode;
  const execMode: ExecMode =
    typeof rawMode === 'string' && (EXEC_MODES as readonly string[]).includes(rawMode)
      ? (rawMode as ExecMode)
      : defaultExecMode;

  // sizeFactor: coerce, then CLAMP to [0, maxSizeUp]. reject overrides to exactly 0.
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

  // execPlan only matters on an approve (a reject sizes to 0). Sanitized to valid legs with
  // fractions clamped to [0,1] — THAT clamp is what guarantees no leg ever prices above the ask.
  const execPlan = verdict === 'approve' ? sanitizePlan(obj.execPlan) : undefined;

  return { verdict, sizeFactor, execMode, reason, ...(execPlan ? { execPlan } : {}) };
}

/** Coerce a value to a spread fraction in [0,1], or undefined if not a finite number. */
function toFrac(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
}

/**
 * Sanitize the model's (untrusted) execPlan into safe legs, or undefined if there's nothing usable
 * (→ caller falls back to the single execMode). Drops legs with an invalid mode or non-positive
 * weight, CLAMPS every fraction to [0,1] (the ≤-ask guarantee), orders low ≤ high, caps at 4 legs.
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
  // ...normalize weights so the recorded plan is tidy; return undefined if nothing survived.
  return legs.length ? normalizeWeights(legs) : undefined;
}

// ── Types / helpers referenced above (shapes only; bodies elided in this excerpt) ──────────────
interface ExecLeg { mode: ExecMode; qtyPct: number; lowFrac?: number; highFrac?: number }
interface LlmCandidate { underlying: string; contract: string; dte: number; ask: number; spot: number; /* + genericized signal scalars */ }
interface LlmContext { accountType: 'cash' | 'margin'; regimeNote?: string; nowEt?: string }
interface LlmClient { messages: { create: (args: unknown) => Promise<{ content: unknown }> } }
declare const CONFIG: { maxSizeUp: number };
declare const MAX_DECISION_TOKENS: number;
declare const SYSTEM_PROMPT: string;
declare const TOOL_DESCRIPTION: string;
declare const INPUT_SCHEMA: unknown;
declare function buildUserContent(cand: LlmCandidate, ctx: LlmContext): string;
declare function extractToolInput(message: { content: unknown }): unknown;
declare function normalizeWeights(legs: ExecLeg[]): ExecLeg[];
