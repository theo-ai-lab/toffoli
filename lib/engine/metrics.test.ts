import { describe, it, expect } from "vitest";
import { loadGoldSet } from "../../dataset/schema";
import { evaluate, wilson, classificationCost } from "./metrics";

describe("evaluate — over the labeled gold set", () => {
  const r = evaluate(loadGoldSet({ includeIncidents: true }));

  it("never produces a DANGEROUS MISS, and never a committed MISSED ESCALATION", () => {
    expect(r.dangerousMisses).toBe(0); // catastrophic: irreversible called auto-undoable
    expect(r.missedEscalations).toBe(0); // the floor never confidently under-calls an irreversible action
  });

  it("reports IRREVERSIBLE recall with a Wilson CI and non-null precision", () => {
    const irr = r.perClass.find((m) => m.cls === "IRREVERSIBLE");
    expect(irr?.recall).not.toBeNull();
    expect(irr?.precision).not.toBeNull();
    expect(r.irreversibleRecallCI).not.toBeNull();
  });

  it("the disclosed cache-delete over-escalation shows up as a safe-direction error, not a dangerous one", () => {
    const irr = r.perClass.find((m) => m.cls === "IRREVERSIBLE");
    // over-escalation (REVERSIBLE truth → IRREVERSIBLE pred) dents IRREVERSIBLE precision but is never a dangerous miss
    expect(irr?.fp ?? 0).toBeGreaterThanOrEqual(1);
    expect((irr?.precision ?? 1)).toBeLessThan(1);
  });
});

describe("metric helpers", () => {
  it("Wilson interval brackets the point estimate and stays in [0,1]", () => {
    const ci = wilson(9, 10);
    expect(ci).not.toBeNull();
    expect(ci!.lo).toBeGreaterThanOrEqual(0);
    expect(ci!.hi).toBeLessThanOrEqual(1);
    expect(ci!.lo).toBeLessThan(0.9);
    expect(ci!.hi).toBeGreaterThan(0.9);
    expect(wilson(0, 0)).toBeNull();
  });

  it("the cost matrix makes a missed irreversible 100x an over-escalation", () => {
    expect(classificationCost("REVERSIBLE", "IRREVERSIBLE")).toBe(100);
    expect(classificationCost("IRREVERSIBLE", "REVERSIBLE")).toBe(2);
    expect(classificationCost("REVERSIBLE", "REVERSIBLE")).toBe(0);
  });
});
