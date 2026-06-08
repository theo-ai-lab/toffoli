/**
 * Toffoli — the SAFE runtime executor (the unattended-deploy execution path).
 *
 * `execute` (lib/exec/executor.ts) is the bare saga loop used by the demo/eval. THIS is the path a
 * deployed, agent-called, mostly-unattended Toffoli runs through. It composes the operational-safety
 * floor the will-deploy frame requires, in one chokepoint:
 *
 *   1. MODE + KILL-SWITCH (mode.ts) — one place decides if the world may be mutated; the kill-switch
 *      forces dry-run, enforced here, not advisory.
 *   2. PLAN-ONLY BY DEFAULT — with no confirm token and no auto-confirm, it emits a plan and mutates
 *      NOTHING, while still escalating the irreversible remainder to a human.
 *   3. CONFIRM-TOKEN GATE — a token bound (by hash) to THIS exact plan authorizes executing all of it
 *      (a human approved it). `autoConfirm` instead runs ONLY policy-auto-eligible steps unattended.
 *   4. POLICY GATE (policy.ts) — class × confidence × default-deny allowlist; the judge can only lower
 *      autonomy, never grant it.
 *   5. WAL JOURNAL (journal.ts) — write-ahead intent → idempotent inverse → durable done/fail. A step
 *      is reported "restored" ONLY if the journal confirms it (the anti-fabrication invariant).
 *   6. RESILIENCE (resilience.ts) — bounded transient-only retry + per-backend circuit breakers.
 *   7. ESCALATION (escalation.ts) — irreversible remainder, COMPENSATION-FAILED, blocked, and
 *      confirm-required all go to a durable sink — never a silent drop.
 *
 * Zero runtime dependencies (node:crypto only, for the plan-bound confirm token).
 */

import { createHash } from "node:crypto";
import type { ResumablePlan } from "../engine/resumable";
import type { Classification } from "../engine/types";
import { dispatchInverse, type InverseOutcome } from "../exec/executor";
import type { RecoveryWorld } from "../exec/world";
import { effectiveMode, mayMutate, type ExecutionMode, type ModeDecision } from "./mode";
import { decideAuto, DEFAULT_AUTO_POLICY, type AutoDecision, type AutoExecutePolicy } from "./policy";
import { InMemoryJournal, type StepJournal, type Clock } from "./journal";
import { Escalator, InMemorySink, type EscalationSink, type OversightRecord } from "./escalation";
import { BreakerRegistry, withRetrySync, isTransient, type BackoffConfig, type RetryBudget } from "./resilience";

export type RuntimeStepStatus =
  | "restored" // ran and the journal confirms success
  | "planned" // plan-only: would run, but nothing was mutated
  | "confirm-required" // not auto-eligible; escalated for a human to approve
  | "compensation-failed" // attempted and failed (after retries) — escalated
  | "unsupported" // no real adapter for this method — escalated
  | "breaker-open" // skipped: the backend's circuit breaker is open — escalated
  | "blocked"; // blocked by an earlier failed compensation (saga) — escalated

export interface RuntimeStepReport {
  index: number;
  forActionId: string;
  method: string;
  status: RuntimeStepStatus;
  detail: string;
  attempts: number;
  autoDecision: AutoDecision;
  /** True iff the durable journal recorded this step DONE — the only basis for reporting "restored". */
  journalConfirmed: boolean;
}

export interface RuntimeReport {
  mode: ModeDecision;
  phase: "plan-only" | "executed";
  steps: RuntimeStepReport[];
  restored: number;
  compensationFailed: number;
  unsupported: number;
  blocked: number;
  /** confirm-required + breaker-open + plan-time irreversible/dominated — everything a human must see. */
  escalated: number;
  escalations: OversightRecord[];
  /** The plan-bound token a caller presents to authorize executing this exact plan. */
  confirmToken: string;
  /**
   * THE ANTI-FABRICATION INVARIANT (defends against the Replit failure mode): every step reported
   * "restored" is backed by a durable journal "done". `pass:false` means a success was fabricated.
   */
  fabricationCheck: { pass: boolean; detail: string };
}

export interface SafeExecuteOptions {
  /** Requested mode; the kill-switch can still force dry-run. Default from env (`sandbox`). */
  mode?: ExecutionMode;
  /** A token bound to THIS plan; presenting the correct one authorizes executing ALL planned steps. */
  confirmToken?: string;
  /** Unattended autonomy: run ONLY policy-auto-eligible steps; escalate the rest. Default false. */
  autoConfirm?: boolean;
  policy?: AutoExecutePolicy;
  journal?: StepJournal;
  sink?: EscalationSink;
  breakers?: BreakerRegistry;
  backoff?: BackoffConfig;
  budget?: RetryBudget;
  rng?: () => number;
  /** Identify the run/caller for the audit trail and correlation. */
  runId?: string;
  caller?: string;
  runbookUrl?: string;
  /** Injected clock for deterministic records/tests. */
  clock?: Clock;
  /** Injected env for deterministic kill-switch tests. */
  env?: NodeJS.ProcessEnv;
  /** Override the inverse runner (tests inject transient faults to exercise retry/breaker). */
  runInverse?: (method: string, params: Record<string, unknown> | undefined, idem: string, world: RecoveryWorld) => InverseOutcome;
  /** Where an escalation-sink delivery failure is surfaced (the deploy routes this to a durable backstop). */
  onDeliveryFailure?: (record: OversightRecord, err: unknown) => void;
}

/** Map a compensation method to the backend whose circuit breaker guards it. */
function backendOf(method: string): string {
  switch (method) {
    case "refund":
      return "payment";
    case "delete":
    case "restore":
      return "store";
    default:
      return method;
  }
}

/** A deterministic token bound to the exact plan (steps + irreversible remainder). No randomness. */
export function computeConfirmToken(plan: ResumablePlan): string {
  const canonical = JSON.stringify({
    steps: plan.steps.map((s) => ({ a: s.forActionId, m: s.compensation.method, k: s.compensation.idempotencyKey, p: s.compensation.params ?? null })),
    escalations: plan.escalations.map((e) => e.forActionId).sort(),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function classOf(plan: ResumablePlan): Map<string, Classification> {
  return new Map(plan.base.classifications.map((c) => [c.actionId, c]));
}

/**
 * Run a resumable plan through the full safety floor. Pure orchestration over the injected world; in
 * `dry-run` (or with the kill-switch engaged, or with neither a token nor autoConfirm) it mutates
 * nothing and only plans + escalates.
 */
export function safeExecute(plan: ResumablePlan, world: RecoveryWorld, opts: SafeExecuteOptions = {}): RuntimeReport {
  const mode = effectiveMode(opts.mode, opts.env ?? process.env);
  const policy = opts.policy ?? DEFAULT_AUTO_POLICY;
  const journal = opts.journal ?? new InMemoryJournal(opts.clock);
  const sink = opts.sink ?? new InMemorySink();
  const breakers = opts.breakers ?? new BreakerRegistry();
  const runInverse = opts.runInverse ?? dispatchInverse;
  const escalator = new Escalator(sink, { runId: opts.runId, caller: opts.caller, runbookUrl: opts.runbookUrl, clock: opts.clock, onDeliveryFailure: opts.onDeliveryFailure });
  const classes = classOf(plan);
  const confirmToken = computeConfirmToken(plan);

  const tokenApproved = Boolean(opts.confirmToken) && opts.confirmToken === confirmToken;
  const tokenRejected = Boolean(opts.confirmToken) && opts.confirmToken !== confirmToken;
  // Plan-only unless a valid token (human-approved the whole plan) OR autoConfirm (unattended autonomy)
  // is given, AND the effective mode permits mutation.
  const willExecute = mayMutate(mode.effective) && (tokenApproved || Boolean(opts.autoConfirm));
  const phase: RuntimeReport["phase"] = willExecute ? "executed" : "plan-only";

  const escalations: OversightRecord[] = [];

  // ── plan-time escalations: the irreversible remainder reaches a human even in plan-only ──
  const dominatedIds = new Set(plan.conflicts.filter((c) => c.type === "dominated-by-irreversible").map((c) => c.actionIds[0]!));
  for (const e of plan.escalations) {
    const kind = dominatedIds.has(e.forActionId) ? "dominated" : "irreversible";
    escalations.push(escalator.emit(kind, e.forActionId, e.decision, e.reason, e.severity));
  }
  if (tokenRejected) {
    escalations.push(
      escalator.emit("confirm-required", "*plan*", "A confirm token was presented but did not match this plan — refused to execute.", "stale or wrong confirm token; the plan may have changed since it was approved", "high"),
    );
  }

  const steps: RuntimeStepReport[] = [];
  let blocked = false;

  for (const step of plan.steps) {
    const { method, params, idempotencyKey: idem } = step.compensation;
    const cls = classes.get(step.forActionId);
    const auto = cls ? decideAuto(cls, step.compensation, policy) : { auto: false, reason: "no classification for action" };
    const base = { index: step.index, forActionId: step.forActionId, method, autoDecision: auto };

    if (blocked) {
      escalations.push(escalator.emit("blocked", step.forActionId, "Resume by hand once the earlier failed compensation is resolved.", "blocked by an earlier failed compensation (saga discipline)", "high", method));
      steps.push({ ...base, status: "blocked", detail: "blocked by an earlier failed compensation", attempts: 0, journalConfirmed: false });
      continue;
    }

    // Plan-only: nothing runs, but show what WOULD run.
    if (!willExecute) {
      steps.push({ ...base, status: "planned", detail: auto.auto ? "would auto-execute" : `would require confirm: ${auto.reason}`, attempts: 0, journalConfirmed: false });
      continue;
    }

    // Authorization: a valid plan token approves every step; autoConfirm approves only auto-eligible.
    const authorized = tokenApproved || auto.auto;
    if (!authorized) {
      escalations.push(escalator.emit("confirm-required", step.forActionId, `A human must approve this compensation before it runs (${method}).`, auto.reason, "medium", method));
      steps.push({ ...base, status: "confirm-required", detail: auto.reason, attempts: 0, journalConfirmed: false });
      continue;
    }

    // Circuit breaker: skip a wedged backend rather than hammer it.
    const breaker = breakers.for(backendOf(method));
    if (!breaker.canAttempt()) {
      escalations.push(escalator.emit("compensation-failed", step.forActionId, `Backend '${backendOf(method)}' circuit is open — compensation deferred.`, "circuit breaker open after repeated failures", "high", method));
      steps.push({ ...base, status: "breaker-open", detail: `circuit open for '${backendOf(method)}'`, attempts: 0, journalConfirmed: false });
      continue;
    }

    // WAL: record intent BEFORE the side effect.
    journal.intend({ idemKey: idem, forActionId: step.forActionId, method });

    // Bounded, transient-only retry around the (idempotent) inverse.
    let outcome: InverseOutcome | undefined;
    const r = withRetrySync<InverseOutcome>(
      () => {
        const o = runInverse(method, params, idem, world);
        if (o.status === "failed") {
          // A failed outcome that carries a thrown `error` is RETRIED iff that error is transient (lock
          // contention, a transient network/I/O fault). A "no-op / not found" failure carries no error
          // and is permanent. This makes bounded transient-retry reachable through the real adapter path
          // (FsWorld and any production adapter surface I/O faults as throws, which dispatchInverse
          // catches into a failed outcome with the raw error attached).
          const transient = o.error !== undefined && isTransient(o.error);
          throw Object.assign(new Error(o.detail), { permanent: !transient });
        }
        return o;
      },
      { backoff: opts.backoff, rng: opts.rng, budget: opts.budget, retryable: (err) => !(err as { permanent?: boolean }).permanent },
    );

    if (r.ok && r.value) {
      outcome = r.value;
    } else {
      outcome = { status: "failed", detail: r.lastError instanceof Error ? r.lastError.message : String(r.lastError ?? "failed") };
    }

    if (outcome.status === "restored") {
      breaker.onSuccess();
      journal.complete(idem, outcome.detail, r.attempts);
      const journalConfirmed = journal.confirms(idem);
      steps.push({ ...base, status: "restored", detail: outcome.detail, attempts: r.attempts, journalConfirmed });
    } else if (outcome.status === "unsupported") {
      // not a backend failure — no breaker hit; cannot auto-undo → escalate, but do not block independents.
      // Release any half-open probe slot WITHOUT a success/failure so the breaker can't wedge half-open.
      breaker.abandonProbe();
      journal.fail(idem, outcome.detail, r.attempts);
      escalations.push(escalator.emit("compensation-failed", step.forActionId, `No real-world adapter for '${method}' — a human must complete this restitution.`, outcome.detail, "high", method));
      steps.push({ ...base, status: "unsupported", detail: outcome.detail, attempts: r.attempts, journalConfirmed: false });
    } else {
      breaker.onFailure();
      journal.fail(idem, outcome.detail, r.attempts);
      escalations.push(escalator.emit("compensation-failed", step.forActionId, `Compensation '${method}' failed after ${r.attempts} attempt(s) — a human must resolve it.`, outcome.detail, "high", method));
      steps.push({ ...base, status: "compensation-failed", detail: outcome.detail, attempts: r.attempts, journalConfirmed: false });
      blocked = true; // saga discipline: never charge past a failed compensation
    }
  }

  // Anti-fabrication: every reported "restored" must be journal-confirmed.
  const fabricated = steps.filter((s) => s.status === "restored" && !s.journalConfirmed);
  const fabricationCheck = {
    pass: fabricated.length === 0,
    detail: fabricated.length === 0 ? "every reported restoration is journal-confirmed" : `${fabricated.length} reported restoration(s) NOT journal-confirmed: ${fabricated.map((s) => s.forActionId).join(", ")}`,
  };

  return {
    mode,
    phase,
    steps,
    restored: steps.filter((s) => s.status === "restored").length,
    compensationFailed: steps.filter((s) => s.status === "compensation-failed").length,
    unsupported: steps.filter((s) => s.status === "unsupported").length,
    blocked: steps.filter((s) => s.status === "blocked").length,
    escalated: escalations.length,
    escalations,
    confirmToken,
    fabricationCheck,
  };
}
