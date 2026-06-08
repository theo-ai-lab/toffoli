import { describe, it, expect } from "vitest";
import { plan } from "./plan";
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

const actions: AgentAction[] = [
  { id: "x1", tool: "db.query", params: { method: "GET" }, at: "2026-01-01T00:00:00Z" },
  { id: "x2", tool: "fs.write", op: "create", at: "2026-01-01T00:01:00Z" },
  { id: "x3", tool: "stripe.charge", op: "pay", target: { kind: "payment", externalized: false }, at: "2026-01-01T00:02:00Z" },
  { id: "x4", tool: "email.send", op: "send", target: { kind: "email", externalized: true }, at: "2026-01-01T00:03:00Z" },
];

describe("plan — the restitution planner", () => {
  const p = plan(actions, classifyAll(actions));

  it("summarizes each outcome", () => {
    expect(p.summary.noEffect).toBe(1);
    expect(p.summary.restored).toBe(1);
    expect(p.summary.compensated).toBe(1);
    expect(p.summary.irreversible).toBe(1);
    expect(p.summary.fullyRecoverable).toBe(false);
  });

  it("identifies the pivot as the earliest irreversible action", () => {
    expect(p.summary.pivotActionId).toBe("x4");
  });

  it("emits compensations LIFO (newest effect first), each with a restoration guarantee", () => {
    expect(p.compensations.map((c) => c.forActionId)).toEqual(["x3", "x2"]);
    expect(p.compensations.find((c) => c.forActionId === "x2")?.restoration).toBe("exact");
    const refund = p.compensations.find((c) => c.forActionId === "x3");
    expect(refund?.restoration).toBe("semantic");
    expect(refund?.method).toBe("refund");
  });

  it("escalates the irreversible remainder as first-class output", () => {
    expect(p.escalations.map((e) => e.forActionId)).toEqual(["x4"]);
    expect(p.escalations[0]?.severity).toBe("high");
  });

  it("a fully-recoverable run has no escalations and a null pivot", () => {
    const safe = actions.slice(0, 3);
    const sp = plan(safe, classifyAll(safe));
    expect(sp.summary.fullyRecoverable).toBe(true);
    expect(sp.escalations).toHaveLength(0);
    expect(sp.summary.pivotActionId).toBeNull();
  });
});
