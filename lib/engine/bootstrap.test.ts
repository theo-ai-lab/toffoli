import { describe, it, expect } from "vitest";
import { generateLabeledSet, split } from "../../dataset/generate";
import { bootstrapRecallCI, irreversibleRecall } from "./bootstrap";
import { evaluate } from "./metrics";

describe("at-scale generated eval + bootstrap", () => {
  const gen = generateLabeledSet({ n: 400, seed: 1234 });

  it("the generator is deterministic and covers all four classes at scale", () => {
    expect(gen).toHaveLength(400);
    expect(generateLabeledSet({ n: 400, seed: 1234 })[200]).toEqual(gen[200]); // reproducible
    const classes = new Set(gen.map((r) => r.target.class));
    expect(classes.size).toBe(4);
  });

  it("never produces a dangerous miss or committed missed-escalation even at scale", () => {
    const r = evaluate(gen);
    expect(r.dangerousMisses).toBe(0);
    expect(r.missedEscalations).toBe(0);
  });

  it("the bootstrap CI brackets the point estimate and is tighter than the tiny-set interval", () => {
    const { heldOut } = split(gen, 7);
    const point = irreversibleRecall(heldOut)!;
    const ci = bootstrapRecallCI(heldOut, { resamples: 1000, seed: 99 });
    expect(ci.n).toBeGreaterThan(20); // real statistical power, unlike n=14
    expect(ci.lo).toBeLessThanOrEqual(point);
    expect(ci.hi).toBeGreaterThanOrEqual(point);
    expect(ci.hi - ci.lo).toBeLessThan(0.5); // tighter than the hand-labeled 0.45–0.88 (≈0.43) interval
  });
});
