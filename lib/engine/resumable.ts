/**
 * Toffoli — the dependency-aware, resumable restitution planner.
 *
 * Upgrades the base planner (plan.ts) with the multi-step-undo semantics a real recovery needs:
 *  - Compensations are ordered by the dependency DAG (graph.ts), not naive LIFO — dependents are
 *    undone before dependencies, so a delete never runs before the writes that depended on it.
 *  - Compensations DOMINATED by a downstream irreversible action are pulled out of the auto-run set
 *    and escalated instead (undoing them can't undo the irreversible effect and may destroy state a
 *    human now needs).
 *  - The plan is a RESUMABLE saga: an ordered list of idempotent steps. An executor runs them in
 *    order; on failure at step k, steps k+1.. are blocked and k is the resume point.
 *
 * Zero dependencies.
 */

import { plan } from "./plan";
import { buildDependencyGraph, type Conflict, type DepEdge } from "./graph";
import type { AgentAction, Classification, CompensatingAction, Escalation, RestitutionPlan } from "./types";

export interface RecoveryStep {
  index: number;
  forActionId: string;
  compensation: CompensatingAction;
}

export interface ResumablePlan {
  base: RestitutionPlan;
  edges: DepEdge[];
  /** Action ids in dependency-correct undo order. */
  undoOrder: string[];
  /** The ordered, conflict-clean compensations an executor runs (a resumable saga). */
  steps: RecoveryStep[];
  /** Cycle + dominated-by-irreversible conflicts — surfaced, never silently mis-ordered. */
  conflicts: Conflict[];
  /** Base escalations PLUS the dominated compensations that were demoted to human review. */
  escalations: Escalation[];
}

export function planResumable(actions: AgentAction[], classifications: Classification[]): ResumablePlan {
  const base = plan(actions, classifications);
  const graph = buildDependencyGraph(actions, classifications);

  // Action ids whose compensation is dominated by a downstream irreversible action (the `from`).
  const dominated = new Set(
    graph.conflicts.filter((c) => c.type === "dominated-by-irreversible").map((c) => c.actionIds[0]!),
  );

  const compById = new Map(base.compensations.map((c) => [c.forActionId, c]));

  const steps: RecoveryStep[] = [];
  for (const id of graph.undoOrder) {
    const comp = compById.get(id);
    if (!comp || dominated.has(id)) continue;
    steps.push({ index: steps.length, forActionId: id, compensation: comp });
  }

  const dominatedEscalations: Escalation[] = [...dominated].map((id) => {
    const c = graph.conflicts.find((k) => k.type === "dominated-by-irreversible" && k.actionIds[0] === id);
    return {
      forActionId: id,
      decision: "Review by hand: a later irreversible action already consumed this action's effect, so undoing it won't help and may destroy state you now need.",
      reason: c?.reason ?? "dominated by a downstream irreversible action",
      severity: "high",
    };
  });

  return {
    base,
    edges: graph.edges,
    undoOrder: graph.undoOrder,
    steps,
    conflicts: graph.conflicts,
    escalations: [...base.escalations, ...dominatedEscalations],
  };
}
