import { describe, it, expect } from "vitest";
import { planResumable } from "./resumable";
import { buildDependencyGraph } from "./graph";
import { classifyDeterministic } from "./classify";
import type { AgentAction, Classification } from "./types";

function classifyAll(actions: AgentAction[]): Classification[] {
  return actions.map(
    (a) =>
      classifyDeterministic(a) ?? {
        actionId: a.id,
        class: "IRREVERSIBLE",
        idempotent: false,
        confidence: 0,
        llmAssisted: false,
        ruleRef: "abstain:fail-safe-escalate",
        rationale: "fail-safe",
      },
  );
}

describe("dependency-aware resumable planner", () => {
  it("orders compensations by dependency, not naive LIFO (undo the write before deleting the file)", () => {
    const actions: AgentAction[] = [
      { id: "a1", tool: "fs.write", op: "create", target: { kind: "file", id: "report.csv" }, at: "2026-01-01T00:00:00Z" },
      { id: "a2", tool: "fs.write", op: "update", target: { kind: "file", id: "report.csv", priorState: "old" }, at: "2026-01-01T00:01:00Z" },
    ];
    const g = buildDependencyGraph(actions, classifyAll(actions));
    expect(g.edges.map((e) => `${e.from}->${e.to}`)).toContain("a1->a2");
    const p = planResumable(actions, classifyAll(actions));
    expect(p.steps.map((s) => s.forActionId)).toEqual(["a2", "a1"]); // dependent undone first
    expect(p.conflicts).toHaveLength(0);
  });

  it("demotes a compensation DOMINATED by a downstream irreversible action to human review", () => {
    const actions: AgentAction[] = [
      { id: "a1", tool: "fs.write", op: "create", target: { kind: "file", id: "report.csv" }, at: "2026-01-01T00:00:00Z" },
      { id: "a2", tool: "email.send", op: "send", target: { kind: "email", externalized: true }, effect: "emailed report.csv to an external client", at: "2026-01-01T00:01:00Z" },
    ];
    const p = planResumable(actions, classifyAll(actions));
    // a1 (create) is recoverable, but a2 (irreversible) already used report.csv → don't auto-undo a1
    expect(p.steps.map((s) => s.forActionId)).not.toContain("a1");
    expect(p.conflicts.some((c) => c.type === "dominated-by-irreversible")).toBe(true);
    expect(p.escalations.map((e) => e.forActionId)).toContain("a1");
    expect(p.escalations.map((e) => e.forActionId)).toContain("a2");
  });

  it("independent actions keep a clean reverse-chronological order with no conflicts", () => {
    const actions: AgentAction[] = [
      { id: "a1", tool: "fs.write", op: "create", target: { kind: "file", id: "x" }, at: "2026-01-01T00:00:00Z" },
      { id: "a2", tool: "stripe.charge", op: "pay", target: { kind: "payment", id: "y", externalized: false }, at: "2026-01-01T00:01:00Z" },
    ];
    const p = planResumable(actions, classifyAll(actions));
    expect(p.steps.map((s) => s.forActionId)).toEqual(["a2", "a1"]);
    expect(p.conflicts).toHaveLength(0);
    // each step carries an idempotency guard so the saga is safe to re-run
    expect(p.steps.every((s) => s.compensation.idempotencyKey.length > 0)).toBe(true);
  });
});
