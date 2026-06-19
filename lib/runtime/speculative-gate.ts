/**
 * Toffoli — the REVERSIBILITY-GATED SPECULATIVE EXECUTION mode.
 *
 * Speculative execution makes an agent faster by firing an action OPTIMISTICALLY before the slow,
 * authoritative permission check returns, then COMMITTING on agreement or ROLLING BACK on rejection.
 * The published framing is "Speculative Actions: A Lossless Framework for Faster Agentic Systems"
 * (arXiv:2510.04371 / OpenReview P0GOk5wslg) and "Sherlock" (arXiv:2511.00330): a cheap predictor
 * fires speculatively while a slower verifier runs in the background; a misprediction is repaired.
 *
 * Both papers note the load-bearing prerequisite for LOSSLESSNESS — the speculative side effect must
 * be inside a "safety envelope": only idempotent, reversible, or sandboxed effects may be speculated,
 * with a "repair path" (rollback / compensating action) when the guess is rejected. Toffoli's whole
 * engine IS that envelope, made provable: this gate reuses the components that already exist —
 *
 *   - the DETERMINISTIC reversibility classifier (lib/engine/classify.ts) as the cheap, model-free
 *     FEASIBILITY predicate (`isSpeculativeSafe`): may this action be fired optimistically at all?
 *   - the PERMISSION ORACLE + an orthogonal POLICY (lib/runtime/permission-oracle.ts) as the slow,
 *     authoritative tier (the "verifier"): is this action actually permitted?
 *   - the RESTITUTION PLANNER + the SAFE EXECUTOR (planResumable + safeExecute) as the repair path:
 *     a rejected speculation is rolled back THROUGH the existing safety floor (WAL journal, bounded
 *     retries, the anti-fabrication invariant), and we VERIFY the world returned to the pre-fire
 *     baseline.
 *
 * THE NOVEL, LOAD-BEARING INVARIANT: the safety envelope is the reversibility floor, so it is provable
 * rather than heuristic. An action is speculated IFF the deterministic floor rates it REVERSIBLE or
 * COMPENSABLE — exactly the classes whose effect a restitution can undo. The IRREVERSIBLE class, and
 * any action the floor ABSTAINS on (uncertainty), are HARD-BLOCKED from ever speculating — fail-closed,
 * unchanged from the rest of Toffoli. So every mis-speculation is, by construction, losslessly
 * recoverable, and the catastrophic action is never fired on a guess. The kill-switch is absolute: when
 * the effective mode forbids mutation, NOTHING is fired — speculation needs both the right to fire and
 * the right to roll back, and an unenforced freeze is worthless (the Replit failure mode).
 *
 * Zero runtime dependencies — pure composition over the engine + runtime modules and node built-ins.
 */

import type { AgentAction, Classification, Restoration, Reversibility } from "../engine/types";
import { classifyDeterministic } from "../engine/classify";
import { planResumable } from "../engine/resumable";
import type { RecoveryWorld, WorldState } from "../exec/world";
import { authorize, type AuthorizationClass } from "./permission-oracle";
import { effectiveMode, mayMutate, type ExecutionMode, type ModeDecision } from "./mode";
import { SANDBOX_AUTO_POLICY, type AutoExecutePolicy } from "./policy";
import { Escalator, InMemorySink, type EscalationSink, type OversightRecord } from "./escalation";
import { safeExecute, type RuntimeReport } from "./safe-executor";
import type { Clock } from "./journal";

// ── stage-1 feasibility: the deterministic classifier AS a speculation predicate ─────────────────

/** The regime this cascade boundary operates in: provable / model-free (no model is consulted). */
export const SPECULATIVE_REGIME = "model-free-provable" as const;
/** The residual locus the gate points at: each agent ACTION is the unit gated (not turn/claim/chunk). */
export const SPECULATIVE_LOCUS = "action" as const;

export interface SpeculativeFeasibility {
  /**
   * True IFF the action may be fired OPTIMISTICALLY: the deterministic floor rates it REVERSIBLE or
   * COMPENSABLE, so a rejected guess can be provably rolled back. IRREVERSIBLE and ABSTAIN are false.
   */
  speculative: boolean;
  /** The deterministic class, or `"ABSTAIN"` when the floor could not decide (→ never speculate). */
  class: AuthorizationClass;
  /** The restoration guarantee a rollback would provide: `exact` (REVERSIBLE), `semantic` (COMPENSABLE), `none`. */
  rollback: Restoration;
  /** One-line, human-legible reason — recorded on the outcome. */
  reason: string;
  /** The full deterministic classification, or `null` on an abstention. */
  classification: Classification | null;
}

/**
 * STAGE-1 FEASIBILITY PREDICATE (the deterministic-first contract seam). A cheap, model-free check of
 * whether an action is *eligible* to be fired speculatively — used as the feasibility filter before
 * the expensive authoritative tier is even consulted. This is the classifier re-cast as a predicate:
 * it never executes anything and never consults a model. `speculative` is true only for REVERSIBLE /
 * COMPENSABLE; everything else (IRREVERSIBLE, ABSTAIN, and the no-mutation NULLIPOTENT read) is not a
 * speculation candidate. Injecting `classify` is for tests ONLY — it never bypasses the floor in prod.
 */
export function isSpeculativeSafe(
  action: AgentAction,
  classify: (a: AgentAction) => Classification | null = classifyDeterministic,
): SpeculativeFeasibility {
  const classification = classify(action);
  if (classification === null) {
    return {
      speculative: false,
      class: "ABSTAIN",
      rollback: "none",
      reason: "the deterministic floor ABSTAINED — uncertainty is not a licence to speculate (fail-closed)",
      classification: null,
    };
  }
  const klass = classification.class;
  switch (klass) {
    case "REVERSIBLE":
      return { speculative: true, class: klass, rollback: "exact", reason: `REVERSIBLE — an exact inverse can undo a rejected guess (${classification.ruleRef})`, classification };
    case "COMPENSABLE":
      return { speculative: true, class: klass, rollback: "semantic", reason: `COMPENSABLE — a compensating action restores equivalent state if rejected (${classification.ruleRef})`, classification };
    case "IRREVERSIBLE":
      return { speculative: false, class: klass, rollback: "none", reason: `IRREVERSIBLE — no rollback exists; provably NEVER speculated (${classification.ruleRef})`, classification };
    case "NULLIPOTENT":
      return { speculative: false, class: klass, rollback: "none", reason: `NULLIPOTENT — a read mutates nothing; it runs directly, with no speculation needed (${classification.ruleRef})`, classification };
  }
}

// ── the slow / authoritative tier: oracle + an orthogonal permission policy ───────────────────────

export interface PermissionVerdict {
  /** True iff the action is authoritatively PERMITTED to stand. */
  permit: boolean;
  /** One-line reason — recorded on the outcome and any escalation. */
  reason: string;
  /** Which tier decided: the reversibility oracle, the orthogonal policy, or both agreeing. */
  source: "oracle" | "policy" | "oracle+policy";
}

/** The slow, authoritative check the gate races against. May be async (a real remote oracle/human). */
export type PermissionCheck = (action: AgentAction) => PermissionVerdict | Promise<PermissionVerdict>;

/**
 * An ORTHOGONAL authorization policy the reversibility floor can't see: spend caps, recipient
 * allowlists, scopes, blast radius. This is the dimension that lets the authoritative tier REJECT an
 * action the cheap reversibility classifier happily rated speculative — i.e. the source of a genuine
 * mis-speculation (and therefore a real rollback).
 */
export interface SpeculativePermissionPolicy {
  permits(action: AgentAction): { permit: boolean; reason: string };
}

/** The permissive default: the reversibility oracle alone decides (no orthogonal constraints). */
export const ALLOW_ALL_POLICY: SpeculativePermissionPolicy = {
  permits: () => ({ permit: true, reason: "no orthogonal policy constraints" }),
};

/** Reject any `pay`/charge whose amount exceeds a spend cap — an authorization dimension orthogonal to reversibility. */
export function spendCapPolicy(capUsd: number): SpeculativePermissionPolicy {
  return {
    permits(action) {
      const amt = action.params?.["amountUsd"];
      if (typeof amt === "number" && amt > capUsd) {
        return { permit: false, reason: `charge $${amt} exceeds the $${capUsd} spend cap — policy reject (orthogonal to reversibility)` };
      }
      return { permit: true, reason: `within the $${capUsd} spend cap` };
    },
  };
}

/** Compose several policies with AND semantics: the FIRST reject wins and names itself. */
export function composePolicies(...policies: SpeculativePermissionPolicy[]): SpeculativePermissionPolicy {
  return {
    permits(action) {
      for (const p of policies) {
        const v = p.permits(action);
        if (!v.permit) return v;
      }
      return { permit: true, reason: "all policies permit" };
    },
  };
}

export interface DefaultPermissionCheckOptions {
  /** The orthogonal authorization policy (spend caps, allowlists). Default: permit everything. */
  policy?: SpeculativePermissionPolicy;
  mode?: ExecutionMode;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
}

/**
 * The default authoritative tier: the reversibility PERMISSION ORACLE (which itself routes through the
 * kill-switch and fails closed on an abstention) AND the orthogonal permission policy. An action is
 * permitted iff the oracle issues PROCEED *and* the policy permits. This is the slow check speculation
 * hides the latency of; the oracle leg never grants more autonomy than the floor allows.
 */
export function defaultPermissionCheck(opts: DefaultPermissionCheckOptions = {}): PermissionCheck {
  const policy = opts.policy ?? ALLOW_ALL_POLICY;
  return (action) => {
    const decision = authorize(action, { mode: opts.mode, env: opts.env, clock: opts.clock });
    if (decision.verdict === "ESCALATE") return { permit: false, reason: decision.reason, source: "oracle" };
    const p = policy.permits(action);
    if (!p.permit) return { permit: false, reason: p.reason, source: "policy" };
    return { permit: true, reason: `oracle PROCEED ∧ ${p.reason}`, source: "oracle+policy" };
  };
}

// ── the gate ──────────────────────────────────────────────────────────────────────────────────────

/** A candidate action the gate may speculate on: its intended descriptor, and a thunk that fires it. */
export interface SpeculativeOp<W extends RecoveryWorld = RecoveryWorld> {
  /**
   * The action the agent INTENDS to perform. Classified BEFORE firing (the pre-act prediction) — this
   * is what the deterministic floor reads, exactly as a real speculative system predicts from the
   * static call descriptor without executing it.
   */
  action: AgentAction;
  /** Fire the optimistic effect against the world, returning the GENUINE `AgentAction` performed (the World convention). */
  fire: (world: W) => AgentAction;
}

export type SpeculativeDisposition =
  | "committed-speculative" // fired optimistically; the authoritative tier agreed → kept (the fast-path win)
  | "rolled-back" // fired optimistically; the authoritative tier rejected → losslessly undone (the repair path)
  | "ran-checked" // NOT speculated (this class is off the operating eligibility set); checked-then-fired synchronously
  | "blocked" // NOT speculated; checked synchronously and rejected → never fired
  | "ran-nullipotent" // a read: ran directly, no speculation, no rollback risk
  | "escalated" // IRREVERSIBLE / ABSTAIN: provably never speculated → deferred to a human (fail-closed)
  | "plan-only"; // the kill-switch / dry-run mode forbids mutation → nothing fired

export interface RollbackResult {
  /** The safe-executor report for the restitution that undid the mis-speculation. */
  report: RuntimeReport;
  /** True iff the recoverable subset (files, rows, ledger net) returned to the exact pre-fire baseline. */
  restoredToBaseline: boolean;
  /**
   * LOSSLESS iff the world returned to baseline AND every reported restoration is journal-confirmed
   * AND no compensation failed/blocked. This is the empirical proof of the safety-envelope invariant.
   */
  lossless: boolean;
}

export interface SpeculativeOutcome {
  actionId: string;
  disposition: SpeculativeDisposition;
  /** The reversibility class (or ABSTAIN) the cheap tier assigned. */
  class: AuthorizationClass;
  feasibility: SpeculativeFeasibility;
  /** True iff the action was actually fired optimistically (before the authoritative verdict was known). */
  fired: boolean;
  /** True iff this action was speculated (fired on a guess): committed-speculative or rolled-back. */
  speculated: boolean;
  /** The cheap tier's INTRINSIC optimistic prediction: would it permit (speculate/run) or defer? */
  fastPermit: boolean;
  /** The authoritative tier's verdict, when it genuinely ran (undefined only in frozen plan-only). */
  authoritative?: PermissionVerdict;
  /** True iff BOTH tiers genuinely ran on this input — the comparison set for the disagreement rate. */
  bothTiersRan: boolean;
  /** Present iff the speculation was rejected and rolled back. */
  rollback?: RollbackResult;
  reason: string;
}

export interface SpeculativeGateOptions<W extends RecoveryWorld = RecoveryWorld> {
  /** The slow / authoritative tier. Default: `defaultPermissionCheck` (oracle + allow-all policy). */
  permissionCheck?: PermissionCheck;
  /** The reversibility classifier. Default: the deterministic floor. Injectable for tests ONLY. */
  classify?: (a: AgentAction) => Classification | null;
  /**
   * The operating eligibility set — which speculatable classes to actually fire optimistically.
   * Default: both REVERSIBLE and COMPENSABLE. Narrowing it (e.g. to REVERSIBLE only) makes the gate
   * fire fewer guesses (more synchronous `ran-checked`), trading hidden latency for fewer rollbacks —
   * this is the parameter the acceptance-vs-restitution-cost curve sweeps.
   */
  speculateClasses?: Reversibility[];
  /** Execution mode (the kill-switch can still force dry-run). Default from env (sandbox). */
  mode?: ExecutionMode;
  env?: NodeJS.ProcessEnv;
  /** The auto-execute policy the ROLLBACK runs under. Default SANDBOX_AUTO_POLICY (so a refund/restore auto-runs). */
  rollbackPolicy?: AutoExecutePolicy;
  clock?: Clock;
  runId?: string;
  caller?: string;
  /** Durable sink the IRREVERSIBLE/ABSTAIN remainder is escalated to. Default a fresh in-memory sink. */
  sink?: EscalationSink;
  onEvent?: (e: { kind: SpeculativeDisposition | "start"; actionId: string; detail: string }) => void;
  /** Override the world snapshot used for the lossless baseline (tests). Default `world.snapshot()`. */
  snapshot?: (world: W) => WorldState;
}

export interface SpeculativeGateReport {
  mode: ModeDecision;
  outcomes: SpeculativeOutcome[];
  escalations: OversightRecord[];
  telemetry: CascadeTelemetry;
  /** Fraction of optimistic fires the authoritative tier PERMITTED (the headline acceptance rate). NaN if none speculated. */
  speculationAcceptanceRate: number;
  /** Total compensation steps executed to roll back mis-speculations — the realized restitution cost. */
  misSpeculationRestitutionCost: number;
}

/** Order-insensitive equality of the recoverable subset of two world snapshots (irreversible dims ignored). */
function recoverableMatches(a: WorldState, b: WorldState): boolean {
  const norm = (o: Record<string, unknown>): string => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y))));
  return norm(a.files) === norm(b.files) && norm(a.rows) === norm(b.rows) && a.ledgerUsd === b.ledgerUsd;
}

/**
 * Run a sequence of candidate actions through the reversibility-gated speculative executor.
 *
 * Per action: classify it with the cheap floor (`isSpeculativeSafe`). If it is speculatable AND in the
 * operating eligibility set, FIRE it optimistically, then resolve the slow authoritative check — on
 * PERMIT keep it (the fast-path win), on REJECT roll it back through the safe executor and verify the
 * world returned to baseline. IRREVERSIBLE / ABSTAIN are never fired (escalated, fail-closed). A read
 * runs directly. When the effective mode forbids mutation, nothing is fired (plan-only) — the
 * kill-switch is absolute.
 */
export async function speculativeExecute<W extends RecoveryWorld>(
  ops: SpeculativeOp<W>[],
  world: W,
  opts: SpeculativeGateOptions<W> = {},
): Promise<SpeculativeGateReport> {
  const classify = opts.classify ?? classifyDeterministic;
  const check = opts.permissionCheck ?? defaultPermissionCheck({ mode: opts.mode, env: opts.env, clock: opts.clock });
  const speculateClasses = opts.speculateClasses ?? ["REVERSIBLE", "COMPENSABLE"];
  const rollbackPolicy = opts.rollbackPolicy ?? SANDBOX_AUTO_POLICY;
  const mode = effectiveMode(opts.mode, opts.env ?? process.env);
  const mayFire = mayMutate(mode.effective);
  const sink = opts.sink ?? new InMemorySink();
  const snapshot = opts.snapshot ?? ((w: W) => w.snapshot());
  const escalator = new Escalator(sink, { runId: opts.runId, caller: opts.caller, clock: opts.clock });
  const emit = opts.onEvent ?? (() => {});

  const outcomes: SpeculativeOutcome[] = [];
  const escalations: OversightRecord[] = [];

  for (const op of ops) {
    const feasibility = isSpeculativeSafe(op.action, classify);
    const klass = feasibility.class;
    // The cheap tier's intrinsic optimistic prediction: a read or a speculatable class is an optimistic
    // PERMIT; IRREVERSIBLE / ABSTAIN is a DEFER. This is independent of the operating eligibility set,
    // so the disagreement rate measures the CLASSIFIER's optimism vs authority, not the operating policy.
    const fastPermit = feasibility.speculative || klass === "NULLIPOTENT";
    emit({ kind: "start", actionId: op.action.id, detail: feasibility.reason });

    // ── kill-switch / dry-run: speculation needs the right to fire AND to roll back; under a freeze it
    //    has neither, so NOTHING is fired. Plan-only, the same absolute chokepoint the rest of Toffoli uses.
    if (!mayFire) {
      outcomes.push({ actionId: op.action.id, disposition: "plan-only", class: klass, feasibility, fired: false, speculated: false, fastPermit, bothTiersRan: false, reason: `${mode.reason} — mutation forbidden; nothing fired (plan-only)` });
      emit({ kind: "plan-only", actionId: op.action.id, detail: mode.reason });
      continue;
    }

    // ── IRREVERSIBLE / ABSTAIN: provably never speculated. Defer to a human (fail-closed). Both tiers
    //    run (the authoritative check confirms the deferral) and they agree.
    if (!feasibility.speculative && klass !== "NULLIPOTENT") {
      const authoritative = await check(op.action);
      const rec = escalator.emit(klass === "IRREVERSIBLE" ? "irreversible" : "judge-unavailable", op.action.id, `A human must authorize this ${klass} action before it runs (${op.action.tool}).`, feasibility.reason, "high", op.action.op);
      escalations.push(rec);
      outcomes.push({ actionId: op.action.id, disposition: "escalated", class: klass, feasibility, fired: false, speculated: false, fastPermit, authoritative, bothTiersRan: true, reason: feasibility.reason });
      emit({ kind: "escalated", actionId: op.action.id, detail: feasibility.reason });
      continue;
    }

    // ── NULLIPOTENT read: no mutation to gate. Run it directly; the authoritative tier permits a read.
    if (klass === "NULLIPOTENT") {
      const authoritative = await check(op.action);
      op.fire(world); // a read: returns its action and mutates nothing
      outcomes.push({ actionId: op.action.id, disposition: "ran-nullipotent", class: klass, feasibility, fired: true, speculated: false, fastPermit, authoritative, bothTiersRan: true, reason: "NULLIPOTENT read — ran directly" });
      emit({ kind: "ran-nullipotent", actionId: op.action.id, detail: "read ran directly" });
      continue;
    }

    // ── speculatable (REVERSIBLE / COMPENSABLE). Two operating sub-cases on the eligibility set: ──
    const inEligibleSet = speculateClasses.includes(klass as Reversibility);

    if (!inEligibleSet) {
      // Off the operating eligibility set: do NOT speculate — run the authoritative check FIRST
      // (synchronous; latency NOT hidden), then fire only on PERMIT. No rollback can be needed.
      const authoritative = await check(op.action);
      if (authoritative.permit) {
        op.fire(world);
        outcomes.push({ actionId: op.action.id, disposition: "ran-checked", class: klass, feasibility, fired: true, speculated: false, fastPermit, authoritative, bothTiersRan: true, reason: `not in speculate set; ran after a synchronous permit (${authoritative.reason})` });
        emit({ kind: "ran-checked", actionId: op.action.id, detail: authoritative.reason });
      } else {
        outcomes.push({ actionId: op.action.id, disposition: "blocked", class: klass, feasibility, fired: false, speculated: false, fastPermit, authoritative, bothTiersRan: true, reason: `not in speculate set; rejected synchronously, never fired (${authoritative.reason})` });
        emit({ kind: "blocked", actionId: op.action.id, detail: authoritative.reason });
      }
      continue;
    }

    // SPECULATE. Snapshot the pre-fire baseline, fire optimistically, then resolve the slow check.
    const baseline = snapshot(world);
    const performed = op.fire(world);
    const authoritative = await check(op.action);

    if (authoritative.permit) {
      // Agreement → COMMIT. The fast path won; the oracle latency was hidden.
      outcomes.push({ actionId: op.action.id, disposition: "committed-speculative", class: klass, feasibility, fired: true, speculated: true, fastPermit, authoritative, bothTiersRan: true, reason: `speculation accepted (${authoritative.reason})` });
      emit({ kind: "committed-speculative", actionId: op.action.id, detail: authoritative.reason });
      continue;
    }

    // Rejection → ROLL BACK through the existing restitution path, then verify losslessness.
    const classification = classify(performed) ?? feasibility.classification;
    const plan = planResumable([performed], classification ? [classification] : []);
    const report = safeExecute(plan, world, { autoConfirm: true, policy: rollbackPolicy, mode: opts.mode, env: opts.env, clock: opts.clock, runId: opts.runId ?? "speculative-rollback", caller: opts.caller ?? "speculative-gate" });
    const restoredToBaseline = recoverableMatches(snapshot(world), baseline);
    const lossless = restoredToBaseline && report.fabricationCheck.pass && report.compensationFailed === 0 && report.blocked === 0 && report.unsupported === 0;
    const rollback: RollbackResult = { report, restoredToBaseline, lossless };
    outcomes.push({ actionId: op.action.id, disposition: "rolled-back", class: klass, feasibility, fired: true, speculated: true, fastPermit, authoritative, bothTiersRan: true, rollback, reason: `speculation REJECTED → rolled back (${authoritative.reason})` });
    emit({ kind: "rolled-back", actionId: op.action.id, detail: `${authoritative.reason}; lossless=${lossless}` });
  }

  const telemetry = cascadeTelemetry(outcomes);
  const speculated = outcomes.filter((o) => o.speculated);
  const accepted = speculated.filter((o) => o.disposition === "committed-speculative").length;
  const restitutionCost = outcomes.reduce((n, o) => n + (o.rollback ? o.rollback.report.restored : 0), 0);

  return {
    mode,
    outcomes,
    escalations,
    telemetry,
    speculationAcceptanceRate: speculated.length === 0 ? Number.NaN : accepted / speculated.length,
    misSpeculationRestitutionCost: restitutionCost,
  };
}

// ── the SUITE cascade-telemetry contract (every repo emits this shape per cheap→expensive boundary) ──

export interface CascadeTelemetry {
  /** The cheap→expensive boundary this slice measures. */
  boundary: string;
  /** Model-free/provable vs model-based residual — this gate is provable (no model is consulted). */
  regime: typeof SPECULATIVE_REGIME;
  /** The residual locus the gate points at (turn/claim/action/step/chunk) — here, per ACTION. */
  locus: typeof SPECULATIVE_LOCUS;
  /** Total actions seen. */
  n: number;
  /** Fraction the cheap/deterministic fast path RESOLVED without the expensive tier overriding (committed speculations + reads). */
  alpha: number;
  /** Of the inputs where BOTH tiers genuinely ran, the fraction on which the cheap and expensive verdicts differed. */
  disagreementRate: number;
  /**
   * Count of cases where the cheap fast path produced an outcome the expensive tier would NOT have AND
   * it was NOT losslessly recoverable — i.e. a mis-speculation whose rollback failed to restore the
   * baseline, OR (the provable invariant) any IRREVERSIBLE/ABSTAIN action that was speculated. MUST be 0.
   */
  losslessViolations: number;
  /** The size of the disagreement comparison set (inputs where both tiers ran). */
  comparable: number;
  /** Per-disposition breakdown, for transparency (the numbers above are derived from these). */
  counts: Record<SpeculativeDisposition, number>;
}

/**
 * Reduce per-action outcomes to the suite's cascade-telemetry slice. ZERO model spend — it is a pure
 * count over the deterministic-vs-deterministic comparison the gate already performed.
 *
 *   alpha             — committed speculations + reads, over n (the cheap tier resolved these losslessly).
 *   disagreementRate  — fast-tier optimism ≠ authoritative verdict, over the set where both tiers ran.
 *   losslessViolations— a rolled-back op that did NOT return to baseline, or an irreversible/abstain
 *                       action that was somehow speculated. Both are 0 by construction; this MEASURES it.
 */
export function cascadeTelemetry(outcomes: SpeculativeOutcome[]): CascadeTelemetry {
  const n = outcomes.length;
  const counts = {
    "committed-speculative": 0,
    "rolled-back": 0,
    "ran-checked": 0,
    blocked: 0,
    "ran-nullipotent": 0,
    escalated: 0,
    "plan-only": 0,
  } as Record<SpeculativeDisposition, number>;
  for (const o of outcomes) counts[o.disposition]++;

  const resolvedByFastPath = counts["committed-speculative"] + counts["ran-nullipotent"];
  const comparableSet = outcomes.filter((o) => o.bothTiersRan && o.authoritative !== undefined);
  const disagreements = comparableSet.filter((o) => o.fastPermit !== o.authoritative!.permit).length;
  const violations = outcomes.filter(
    (o) =>
      (o.disposition === "rolled-back" && o.rollback !== undefined && !o.rollback.lossless) ||
      (o.speculated && (o.class === "IRREVERSIBLE" || o.class === "ABSTAIN")),
  ).length;

  return {
    boundary: "reversibility-classifier → permission-oracle/policy",
    regime: SPECULATIVE_REGIME,
    locus: SPECULATIVE_LOCUS,
    n,
    alpha: n === 0 ? 0 : resolvedByFastPath / n,
    disagreementRate: comparableSet.length === 0 ? 0 : disagreements / comparableSet.length,
    losslessViolations: violations,
    comparable: comparableSet.length,
    counts,
  };
}

/** A one-line, recruiter-legible rendering of a telemetry slice (percentages rounded to 1 dp). */
export function renderTelemetrySentence(t: CascadeTelemetry): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return (
    `the deterministic fast path resolves ${pct(t.alpha)} of actions losslessly (speculate-and-commit or read-only); ` +
    `the policy/oracle tier is load-bearing for only ${pct(1 - t.alpha)}, at ${pct(t.disagreementRate)} measured disagreement, ` +
    `with ${t.losslessViolations} lossless violations (n=${t.n}, regime=${t.regime}, locus=${t.locus})`
  );
}
