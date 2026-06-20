/**
 * Toffoli — DETERMINISTIC-FIRST RECEDING-HORIZON PLANNING (Model Predictive Control).
 *
 * Learned-verifier-guided search (LLM tree search, process-/outcome-reward value functions,
 * "verifier-guided" or "self-consistency-as-verifier" decoding) puts the EXPENSIVE component on the
 * SCORING side: a model is evaluated at every node to estimate how good a partial plan is, and the
 * proposer is cheap. This controller INVERTS that cost curve. The load-bearing filter is moved to the
 * front and made EXACT and FREE:
 *
 *   PROPOSE  — enumerate candidate action sequences toward a goal over a domain action library, rolled
 *              forward with the domain's own deterministic dynamics model. No model spend.
 *   PRUNE    — STAGE 1, the deterministic-first inversion. Each candidate is filtered by the
 *              REVERSIBILITY CLASSIFIER reused exactly as it is everywhere else in Toffoli
 *              (`isSpeculativeSafe` / `classifyDeterministic`): any plan that would take an action the
 *              floor rates IRREVERSIBLE — or ABSTAINS on (uncertainty) — is dropped. This is an EXACT,
 *              ZERO-COST feasibility/safety filter, not a learned verifier. The catastrophic branch is
 *              eliminated BEFORE any expensive evaluation could even run.
 *   SCORE    — STAGE 2, a DETERMINISTIC objective over the survivors: goal-progress (predicted distance
 *              reduction) MINUS an irreversibility/blast-radius cost derived from the reversibility
 *              class. Among equally-progressing FEASIBLE plans this prefers the reversible route over a
 *              compensable one, and a low-blast action over a high-blast one. No model spend.
 *   STEP     — execute exactly ONE action — the first action of the best plan — through Toffoli's
 *              EXISTING safe forward path (the speculative gate, which itself routes any rejected fire
 *              back through `safeExecute`). The action committed to the real world is, by stage-1
 *              construction, always one a restitution can undo.
 *   OBSERVE  — re-read the true world state and RE-PLAN from it (receding horizon). When the observed
 *              effect diverges from the model's prediction (an unmodeled disturbance), the next plan is
 *              computed from the truth, so the controller ADAPTS instead of executing a stale open-loop
 *              plan to completion.
 *
 * HONEST FRAMING. This is a DEMONSTRATION HARNESS, not a deployed planner: the proposer enumerates a
 * bounded, small action library over a fixed domain, and the objective is hand-specified. The novel,
 * defensible claim is narrow and verifiable by running it: the SAFETY filter that prunes the search is
 * exact and costs zero model spend (the same deterministic floor Toffoli proves elsewhere), so an
 * irreversible action can be eliminated from the plan for free — the inverse of paying a learned
 * verifier to (probabilistically) notice it. Where a learned value function WOULD plug in is the
 * stage-2 `cost`/objective seam; the default objective here is deterministic on purpose (zero spend,
 * fully reproducible).
 *
 * Zero runtime dependencies — pure composition over the engine + runtime modules.
 */

import type { AgentAction, Classification, Reversibility } from "../engine/types";
import { classifyDeterministic } from "../engine/classify";
import type { RecoveryWorld } from "../exec/world";
import { isSpeculativeSafe, speculativeExecute, defaultPermissionCheck, spendCapPolicy, type SpeculativeOp, type SpeculativeDisposition } from "./speculative-gate";
import { planResumable } from "../engine/resumable";
import { safeExecute, type RuntimeReport } from "./safe-executor";
import { SANDBOX_AUTO_POLICY } from "./policy";
import type { ExecutionMode } from "./mode";
import type { Clock } from "./journal";

// ── the domain contract ─────────────────────────────────────────────────────────────────────────

/**
 * A candidate action the planner may propose. It IS a `SpeculativeOp` (so the chosen step executes
 * through the existing speculative gate unchanged) plus a PURE dynamics model (`predict`) the proposer
 * rolls forward to enumerate plans without touching the world.
 */
export interface CandidateAction<W extends RecoveryWorld, S> extends SpeculativeOp<W> {
  /** The model of this action's effect on the planning state. PURE — never mutates anything. */
  predict: (state: S) => S;
  /** A short, human-legible label for the trace (defaults to the action id). */
  label?: string;
}

/**
 * A planning domain over a world `W` with an abstract planning state `S`. Everything here is
 * DETERMINISTIC: `observe` is a pure projection of the world snapshot, `actions` is a pure function of
 * the state, `distance` is the goal-progress measure (0 ⇔ goal), and `cost` is the optional stage-2
 * blast/irreversibility penalty.
 */
export interface PlanningDomain<W extends RecoveryWorld, S> {
  /** Observe the true planning state from the world — the MPC feedback signal. PURE (a read). */
  observe: (world: W) => S;
  /** The action library available AT a (predicted or observed) state. PURE. */
  actions: (state: S) => CandidateAction<W, S>[];
  /** Goal-progress: 0 ⇔ goal reached; larger ⇔ further away. MUST be ≥ 0 and finite. */
  distance: (state: S) => number;
  /**
   * STAGE-2 per-step cost = irreversibility weight × blast radius, used to discriminate among FEASIBLE
   * plans of equal progress. Defaults to `defaultStepCost`. MUST be ≥ 0 for any feasible action.
   */
  cost?: (action: AgentAction, c: Classification | null, state: S) => number;
}

// ── stage-2 default cost: irreversibility class × blast radius ────────────────────────────────────

/** Class weight: reversible is cheap (exact undo), compensable is dearer (semantic-only undo). */
const CLASS_WEIGHT: Record<Reversibility, number> = {
  NULLIPOTENT: 0,
  REVERSIBLE: 1,
  COMPENSABLE: 8,
  // Never reached for a FEASIBLE plan (stage-1 prunes it); guarded as a hard wall regardless.
  IRREVERSIBLE: Number.POSITIVE_INFINITY,
};

/** A deterministic, structural blast-radius estimate from the action descriptor (no model). */
export function blastRadius(action: AgentAction): number {
  const amt = action.params?.["amountUsd"];
  if (typeof amt === "number") return Math.max(1, Math.abs(amt)); // money moved is the blast
  if (action.op === "send" || action.op === "publish") return 100; // external reach is large
  if (action.target?.kind === "table") return 50; // a whole table is a large structural blast
  return 1; // a single file/row op
}

/**
 * The default stage-2 cost. Derived deterministically from the reversibility class and a structural
 * blast-radius estimate — never a tuned magic constant and never a model call. An ABSTAIN (null
 * classification) is treated as maximally costly so it can never win scoring even if it slipped the
 * stage-1 filter (it cannot — ABSTAIN is pruned — but the objective fails safe regardless).
 */
export function defaultStepCost(action: AgentAction, c: Classification | null): number {
  if (c === null) return Number.POSITIVE_INFINITY;
  return CLASS_WEIGHT[c.class] * blastRadius(action);
}

// ── stage-1 feasibility (the EXACT, FREE deterministic-first filter) ──────────────────────────────

/** The reason a single action is or is not plan-feasible, from the deterministic floor. */
export interface ActionFeasibility {
  action: AgentAction;
  /** REVERSIBLE/COMPENSABLE (speculatable) and NULLIPOTENT (a read) are feasible; IRREVERSIBLE/ABSTAIN are not. */
  feasible: boolean;
  class: Reversibility | "ABSTAIN";
  reason: string;
}

/**
 * Classify ONE candidate action with the deterministic floor and decide plan-feasibility. A read
 * (NULLIPOTENT) is feasible (nothing to undo); REVERSIBLE/COMPENSABLE are feasible (a restitution can
 * undo them); IRREVERSIBLE and ABSTAIN are NOT — exactly the classes the speculative gate refuses to
 * fire on. Reuses `isSpeculativeSafe`, the same seam the speculative executor uses.
 */
export function actionFeasibility<W extends RecoveryWorld, S>(
  candidate: CandidateAction<W, S>,
  classify: (a: AgentAction) => Classification | null = classifyDeterministic,
): ActionFeasibility {
  const f = isSpeculativeSafe(candidate.action, classify);
  const feasible = f.speculative || f.class === "NULLIPOTENT";
  return { action: candidate.action, feasible, class: f.class, reason: f.reason };
}

// ── propose ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Enumerate candidate plans: every sequence of STRICTLY distance-reducing actions reachable from
 * `state` under the domain dynamics, up to `horizon` steps, stopping a branch at the goal. Strict
 * progress + the goal-stop bound the search by `distance(state)`, so it terminates without a visited
 * set; `horizon` is an additional hard cap. Deterministic: it follows `domain.actions(state)` order.
 */
export function proposePlans<W extends RecoveryWorld, S>(
  domain: PlanningDomain<W, S>,
  state: S,
  horizon: number,
): CandidateAction<W, S>[][] {
  const here = domain.distance(state);
  if (here === 0 || horizon === 0) return [[]];
  const plans: CandidateAction<W, S>[][] = [];
  let expanded = false;
  for (const action of domain.actions(state)) {
    const next = action.predict(state);
    if (domain.distance(next) >= here) continue; // only branches that make real progress
    expanded = true;
    for (const tail of proposePlans(domain, next, horizon - 1)) plans.push([action, ...tail]);
  }
  // A dead end (no progressing action) contributes the empty continuation so a partial plan still scores.
  return expanded ? plans : [[]];
}

// ── score ───────────────────────────────────────────────────────────────────────────────────────

export interface ScoredPlan<W extends RecoveryWorld, S> {
  actions: CandidateAction<W, S>[];
  /** Reversibility class of each action, in order. */
  classes: (Reversibility | "ABSTAIN")[];
  /** Predicted distance after rolling the whole plan forward on the model. */
  terminalDistance: number;
  /** Progress = start distance − terminal distance (higher is better). */
  progress: number;
  /** Σ of the deterministic stage-2 step costs. */
  cost: number;
  /** Objective: PROGRESS_WEIGHT·progress − cost. Higher is better. */
  score: number;
  /** True iff the plan reaches the goal (terminalDistance === 0). */
  reachesGoal: boolean;
}

export interface PrunedPlan<W extends RecoveryWorld, S> {
  actions: CandidateAction<W, S>[];
  /** The first infeasible action that caused the prune. */
  culprit: ActionFeasibility;
}

/** Progress dominates the objective; cost only ever breaks ties between equal-progress feasible plans. */
export const PROGRESS_WEIGHT = 1000;

/**
 * The full planner decision at one state: propose → stage-1 prune (exact, free) → stage-2 score. PURE
 * (no world mutation), so it is the unit under test for "irreversible plans are pruned" and "reversible
 * is preferred". `feasible` is sorted best-first; `chosen` is the first action of the best plan.
 */
export interface PlanDecision<W extends RecoveryWorld, S> {
  startDistance: number;
  proposed: number;
  /** Plans dropped by the stage-1 reversibility filter, with the culprit action. */
  pruned: PrunedPlan<W, S>[];
  /** Surviving plans, scored and sorted best-first. */
  feasible: ScoredPlan<W, S>[];
  /** The best feasible plan, or null if everything was pruned / nothing progresses. */
  best: ScoredPlan<W, S> | null;
  /** The single action to execute this step (MPC), or null if there is no feasible progressing plan. */
  chosen: CandidateAction<W, S> | null;
}

export interface DecideOptions {
  /** Hard cap on plan length. Defaults to the start distance (the natural bound under strict progress). */
  horizon?: number;
  /** Injectable classifier — tests ONLY; defaults to the deterministic floor. */
  classify?: (a: AgentAction) => Classification | null;
}

export function decide<W extends RecoveryWorld, S>(
  domain: PlanningDomain<W, S>,
  state: S,
  opts: DecideOptions = {},
): PlanDecision<W, S> {
  const classify = opts.classify ?? classifyDeterministic;
  const costOf = domain.cost ?? defaultStepCost;
  const startDistance = domain.distance(state);
  const horizon = opts.horizon ?? Math.max(startDistance, 1);

  // PROPOSE
  const proposals = proposePlans(domain, state, horizon).filter((p) => p.length > 0);

  // STAGE 1 — exact, free reversibility prune.
  const pruned: PrunedPlan<W, S>[] = [];
  const survivors: CandidateAction<W, S>[][] = [];
  for (const plan of proposals) {
    let culprit: ActionFeasibility | null = null;
    for (const action of plan) {
      const f = actionFeasibility(action, classify);
      if (!f.feasible) {
        culprit = f;
        break;
      }
    }
    if (culprit) pruned.push({ actions: plan, culprit });
    else survivors.push(plan);
  }

  // STAGE 2 — deterministic objective over the survivors.
  const feasible: ScoredPlan<W, S>[] = survivors.map((plan) => {
    let s = state;
    let cost = 0;
    const classes: (Reversibility | "ABSTAIN")[] = [];
    for (const action of plan) {
      const c = classify(action.action);
      classes.push(c ? c.class : "ABSTAIN");
      cost += costOf(action.action, c, s);
      s = action.predict(s);
    }
    const terminalDistance = domain.distance(s);
    const progress = startDistance - terminalDistance;
    return { actions: plan, classes, terminalDistance, progress, cost, score: PROGRESS_WEIGHT * progress - cost, reachesGoal: terminalDistance === 0 };
  });

  feasible.sort(compareScored);
  const best = feasible[0] ?? null;
  return { startDistance, proposed: proposals.length, pruned, feasible, best, chosen: best?.actions[0] ?? null };
}

/** Deterministic ordering: higher score, then shorter plan, then lexicographic action-id sequence. */
function compareScored<W extends RecoveryWorld, S>(a: ScoredPlan<W, S>, b: ScoredPlan<W, S>): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.actions.length !== b.actions.length) return a.actions.length - b.actions.length;
  const ai = a.actions.map((x) => x.action.id).join(">");
  const bi = b.actions.map((x) => x.action.id).join(">");
  return ai.localeCompare(bi);
}

// ── execute one step through the existing safe forward path ───────────────────────────────────────

/** The result of executing one chosen action against the real world. */
export interface StepExecution {
  /** True iff the optimistic effect was fired at all. */
  fired: boolean;
  /** True iff the effect was KEPT (committed / ran). A rolled-back or escalated step is NOT committed. */
  committed: boolean;
  disposition: SpeculativeDisposition;
  /** The genuine `AgentAction` performed (for episode-level restitution), when one was fired. */
  performed?: AgentAction;
  reason: string;
}

/** How a chosen step is executed. Injectable so tests can run a pure executor; default uses the gate. */
export type StepExecutor<W extends RecoveryWorld> = (op: SpeculativeOp<W>, world: W) => Promise<StepExecution>;

export interface GateStepExecutorOptions {
  mode?: ExecutionMode;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  /** Spend cap for the orthogonal policy the gate's authoritative tier composes in. Default 1e9 (effectively off). */
  spendCapUsd?: number;
  runId?: string;
  caller?: string;
}

/**
 * The default per-step executor: run the chosen action through the EXISTING speculative gate. The gate
 * classifies + fires it optimistically, races the authoritative oracle/policy check, and on rejection
 * rolls it back through `safeExecute` — so the planner never has to re-implement the safety floor, and
 * a step that the authority rejects simply makes no progress (the controller re-plans from the truth).
 */
export function gateStepExecutor<W extends RecoveryWorld>(opts: GateStepExecutorOptions = {}): StepExecutor<W> {
  const check = defaultPermissionCheck({ policy: spendCapPolicy(opts.spendCapUsd ?? 1e9), mode: opts.mode, env: opts.env, clock: opts.clock });
  return async (op, world) => {
    let performed: AgentAction | undefined;
    const wrapped: SpeculativeOp<W> = {
      action: op.action,
      fire: (w) => {
        performed = op.fire(w);
        return performed;
      },
    };
    const report = await speculativeExecute([wrapped], world, { permissionCheck: check, mode: opts.mode, env: opts.env, clock: opts.clock, runId: opts.runId, caller: opts.caller });
    const o = report.outcomes[0]!;
    const committed = o.disposition === "committed-speculative" || o.disposition === "ran-checked" || o.disposition === "ran-nullipotent";
    return { fired: o.fired, committed, disposition: o.disposition, performed: committed ? performed : undefined, reason: o.reason };
  };
}

// ── the receding-horizon control loop ─────────────────────────────────────────────────────────────

export interface HorizonIteration<W extends RecoveryWorld, S> {
  step: number;
  /** Observed goal distance at the top of this iteration. */
  observedDistance: number;
  decision: PlanDecision<W, S>;
  /** The action chosen and executed this step (null if the controller could not progress safely). */
  chosen: CandidateAction<W, S> | null;
  /** Distance the MODEL predicted after the chosen step. */
  predictedDistance: number;
  /** Distance actually OBSERVED after executing (and after any environment disturbance). */
  nextObservedDistance: number;
  /** True iff observed ≠ predicted — an unmodeled disturbance the receding horizon then adapts to. */
  diverged: boolean;
  execution: StepExecution | null;
}

export interface HorizonEpisode<W extends RecoveryWorld, S> {
  iterations: HorizonIteration<W, S>[];
  /** True iff the controller drove the world to the goal (distance 0). */
  reachedGoal: boolean;
  steps: number;
  /** The genuine actions actually committed to the world, in order (for episode-level restitution). */
  executedActions: AgentAction[];
  /** Number of iterations where the observed effect diverged from the model's prediction. */
  divergences: number;
  /**
   * THE SAFETY INVARIANT, MEASURED: the count of executed actions that classify IRREVERSIBLE. MUST be
   * 0 — stage-1 prunes any plan containing one and the gate independently refuses to fire it.
   */
  irreversibleExecuted: number;
  /** Total deterministic stage-2 cost actually incurred by the executed steps. */
  totalCost: number;
  /** Why the loop stopped: reached the goal, ran out of steps, or found no safe progressing plan. */
  stop: "goal" | "budget" | "no-feasible-plan";
}

export interface HorizonControlOptions<W extends RecoveryWorld, S> extends GateStepExecutorOptions {
  /** Max controller iterations (safety bound against a non-converging domain). Default 32. */
  maxSteps?: number;
  /** Planning horizon per iteration. Default: the observed distance (the natural strict-progress bound). */
  horizon?: number;
  /** Injectable step executor (tests). Default `gateStepExecutor`. */
  executor?: StepExecutor<W>;
  /**
   * Environment disturbance hook, applied to the REAL world AFTER each executed step — an UNMODELED
   * dynamic the planner cannot predict (this is how the divergence/adaptation story is exercised). The
   * planner never calls this itself; the scenario injects it. PURE planners pass nothing.
   */
  onAfterStep?: (step: number, world: W) => void;
  /** Trace callback for the demo. */
  onIteration?: (it: HorizonIteration<W, S>) => void;
}

/**
 * Drive a world to the domain goal by receding-horizon MPC: each iteration observe → propose → prune
 * (exact, free) → score → execute ONE step through the safe gate → re-observe → repeat. Returns the
 * full episode trace. Deterministic given a deterministic domain, executor, clock, and disturbance.
 */
export async function recedingHorizonControl<W extends RecoveryWorld, S>(
  domain: PlanningDomain<W, S>,
  world: W,
  opts: HorizonControlOptions<W, S> = {},
): Promise<HorizonEpisode<W, S>> {
  const maxSteps = opts.maxSteps ?? 32;
  const executor = opts.executor ?? gateStepExecutor<W>(opts);
  const iterations: HorizonIteration<W, S>[] = [];
  const executedActions: AgentAction[] = [];
  let divergences = 0;
  let totalCost = 0;
  let stop: HorizonEpisode<W, S>["stop"] = "budget";

  for (let step = 0; step < maxSteps; step++) {
    const observed = domain.observe(world);
    const observedDistance = domain.distance(observed);
    if (observedDistance === 0) {
      stop = "goal";
      break;
    }

    const decision = decide(domain, observed, { horizon: opts.horizon });
    const chosen = decision.chosen;
    if (chosen === null || decision.best === null) {
      // No feasible plan that makes progress: every route to the goal would take an irreversible /
      // uncertain action. The controller refuses — exactly the fail-closed posture of the floor.
      iterations.push({ step, observedDistance, decision, chosen: null, predictedDistance: observedDistance, nextObservedDistance: observedDistance, diverged: false, execution: null });
      opts.onIteration?.(iterations[iterations.length - 1]!);
      stop = "no-feasible-plan";
      break;
    }

    const predictedDistance = domain.distance(chosen.predict(observed));
    const execution = await executor(chosen, world);
    if (execution.committed && execution.performed) {
      executedActions.push(execution.performed);
      const c = classifyDeterministic(execution.performed);
      totalCost += (domain.cost ?? defaultStepCost)(execution.performed, c, observed);
    }

    // The environment may now perturb the world in a way the model never saw (unmodeled disturbance).
    opts.onAfterStep?.(step, world);

    const nextObserved = domain.observe(world);
    const nextObservedDistance = domain.distance(nextObserved);
    const diverged = nextObservedDistance !== predictedDistance;
    if (diverged) divergences++;

    const it: HorizonIteration<W, S> = { step, observedDistance, decision, chosen, predictedDistance, nextObservedDistance, diverged, execution };
    iterations.push(it);
    opts.onIteration?.(it);
  }

  const irreversibleExecuted = executedActions.filter((a) => classifyDeterministic(a)?.class === "IRREVERSIBLE").length;
  return { iterations, reachedGoal: stop === "goal", steps: iterations.filter((i) => i.execution?.committed).length, executedActions, divergences, irreversibleExecuted, totalCost, stop };
}

// ── episode restitution: undo the whole trajectory through the EXISTING safeExecute ───────────────

export interface EpisodeRestitutionOptions {
  mode?: ExecutionMode;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  runId?: string;
  caller?: string;
}

/**
 * Undo an entire executed trajectory through Toffoli's EXISTING safe runtime executor (`safeExecute`).
 * Because stage-1 admitted ONLY reversible/compensable actions to the world, the whole episode is, by
 * construction, recoverable: classify each performed action, plan the resumable restitution, and run it
 * unattended under the sandbox auto-policy (auto-eligible methods: delete / restore / refund). This is
 * the deep payoff of the deterministic-first prune — the trajectory the planner committed can be put
 * back, and `safeExecute`'s anti-fabrication invariant proves every reported restoration is real.
 */
export function restituteEpisode(executedActions: AgentAction[], world: RecoveryWorld, opts: EpisodeRestitutionOptions = {}): RuntimeReport {
  const classifications: Classification[] = [];
  for (const a of executedActions) {
    const c = classifyDeterministic(a);
    if (c) classifications.push(c);
  }
  const plan = planResumable(executedActions, classifications);
  return safeExecute(plan, world, {
    autoConfirm: true,
    policy: SANDBOX_AUTO_POLICY,
    mode: opts.mode,
    env: opts.env,
    clock: opts.clock,
    runId: opts.runId ?? "horizon-episode-restitution",
    caller: opts.caller ?? "horizon-planner",
  });
}
