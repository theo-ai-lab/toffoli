/**
 * Toffoli — the action dependency graph (the multi-step-undo core).
 *
 * Naive LIFO ("undo newest first") is wrong in general: undoing one action can invalidate
 * another's undo, and an action whose effect was already consumed by a downstream IRREVERSIBLE
 * action must NOT be blindly undone. This module builds the dependency DAG over a run and derives
 * a correct, conflict-checked UNDO ordering.
 *
 * Model:
 *  - A resource is identified by `${kind}:${id}` on an action's target.
 *  - Action B DEPENDS ON action A (edge A → B) when A happened-before B and they touch the same
 *    resource, or B's params reference A's target id (B used what A produced).
 *  - The correct undo order is the REVERSE topological order: undo dependents before dependencies
 *    (undo the write before deleting the file it wrote to).
 *
 * Conflicts the ordering can't resolve are surfaced, not silently mis-ordered:
 *  - `cycle`                  — a dependency cycle; no valid order exists.
 *  - `dominated-by-irreversible` — a recoverable action whose resource was consumed by a downstream
 *                               IRREVERSIBLE action; undoing it won't undo the irreversible effect
 *                               and may destroy state a human now needs. Escalate, don't auto-run.
 *
 * Zero dependencies.
 */

import type { AgentAction, Classification, Reversibility } from "./types";

export interface DepEdge {
  /** `from` happened-before and is depended-ON by `to`. */
  from: string;
  to: string;
  reason: string;
}

export interface Conflict {
  type: "cycle" | "dominated-by-irreversible";
  actionIds: string[];
  reason: string;
}

export interface DependencyGraph {
  edges: DepEdge[];
  /** Action ids in the order compensations should run (dependents before dependencies). */
  undoOrder: string[];
  conflicts: Conflict[];
}

function resourceKey(a: AgentAction): string | undefined {
  const t = a.target;
  return t && t.id !== undefined ? `${t.kind}:${t.id}` : undefined;
}

/** Does B's params/effect reference A's target id (B used what A produced)? */
function referencesProducer(b: AgentAction, a: AgentAction): boolean {
  const id = a.target?.id;
  if (id === undefined) return false;
  const hay = `${JSON.stringify(b.params ?? {})} ${b.effect ?? ""}`;
  return hay.includes(id);
}

/** Chronological order (by `at` when all present, else input order). */
function chrono(actions: AgentAction[]): AgentAction[] {
  const ts = actions.every((a) => typeof a.at === "string");
  return ts ? [...actions].sort((x, y) => (x.at as string).localeCompare(y.at as string)) : actions;
}

export function buildDependencyGraph(actions: AgentAction[], classifications: Classification[]): DependencyGraph {
  const cls = new Map<string, Reversibility>(classifications.map((c) => [c.actionId, c.class]));
  const ordered = chrono(actions);
  const edges: DepEdge[] = [];

  // Build edges over the happened-before relation (i < j chronologically).
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i]!;
      const b = ordered[j]!;
      const ka = resourceKey(a);
      const kb = resourceKey(b);
      if (ka && kb && ka === kb) {
        edges.push({ from: a.id, to: b.id, reason: `both touch ${ka}` });
      } else if (referencesProducer(b, a)) {
        edges.push({ from: a.id, to: b.id, reason: `${b.id} references ${a.target?.id}` });
      }
    }
  }

  const conflicts: Conflict[] = [];

  // dominated-by-irreversible: A (recoverable) → B (irreversible) on the same resource lineage.
  for (const e of edges) {
    const ca = cls.get(e.from);
    const cb = cls.get(e.to);
    if (cb === "IRREVERSIBLE" && (ca === "REVERSIBLE" || ca === "COMPENSABLE")) {
      conflicts.push({
        type: "dominated-by-irreversible",
        actionIds: [e.from, e.to],
        reason: `undoing ${e.from} cannot undo the irreversible ${e.to} that consumed its effect — review before running`,
      });
    }
  }

  const { undoOrder, cycle } = topoUndoOrder(ordered, edges);
  if (cycle.length) {
    conflicts.push({ type: "cycle", actionIds: cycle, reason: "dependency cycle — no valid undo order exists; escalate the cycle" });
  }

  return { edges, undoOrder, conflicts };
}

/**
 * Kahn topological sort over the dependency DAG, then reversed for the undo order. Ties broken by
 * input order for determinism. Returns the leftover (cyclic) nodes if a cycle is present.
 */
function topoUndoOrder(ordered: AgentAction[], edges: DepEdge[]): { undoOrder: string[]; cycle: string[] } {
  const ids = ordered.map((a) => a.id);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    out.get(e.from)!.push(e.to);
  }
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const topo: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    topo.push(n);
    for (const m of out.get(n) ?? []) {
      const d = (indeg.get(m) ?? 0) - 1;
      indeg.set(m, d);
      if (d === 0) queue.push(m);
    }
  }
  const cycle = ids.filter((id) => (indeg.get(id) ?? 0) > 0);
  // Undo order = reverse topological (dependents before dependencies). Cyclic nodes appended.
  return { undoOrder: [...topo].reverse().concat(cycle), cycle };
}
