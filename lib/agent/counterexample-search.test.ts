import { describe, it, expect } from "vitest";
import {
  searchCounterexamples,
  reproduceKnownGaps,
  independentTrueClass,
  effectiveClass,
  severityOf,
  mutateCase,
  KNOWN_OP_RESOLUTION_GAPS,
  type SearchCase,
} from "./counterexample-search";
import type { AgentAction, Reversibility } from "../engine/types";

const REV: Reversibility[] = ["NULLIPOTENT", "REVERSIBLE", "COMPENSABLE", "IRREVERSIBLE"];

describe("counterexample search — the empirical complement to the Lean no-under-call proof", () => {
  it("finds ZERO under-calls across 2000 fair adversarial cases (the domain the proof models)", () => {
    const r = searchCounterexamples({ count: 2000, seed: 0xc0ffee });
    expect(r.casesRun).toBeGreaterThanOrEqual(2000);
    // The headline: the classifier never resolves a fair surface to a class SAFER than the fact-based truth.
    expect(r.underCalls, r.underCalls.map((u) => u.rationale).join("\n")).toEqual([]);
  });

  it("the sweep is NON-VACUOUS: all four classes are exercised, with real over-calls and abstentions", () => {
    const r = searchCounterexamples({ count: 2000, seed: 0xc0ffee });
    for (const c of REV) expect(r.classesSeen[c], `class ${c} exercised`).toBeGreaterThan(0);
    // the `>=` no-under-call tolerance is genuinely tested in the over-call direction…
    expect(r.strictOverCalls).toBeGreaterThan(0);
    // …and the abstain ↦ IRREVERSIBLE fail-safe lens actually fires
    expect(r.abstentions).toBeGreaterThan(0);
    // and the sweep spread across many attack surfaces
    expect(Object.keys(r.profilesSeen).length).toBeGreaterThan(10);
  });

  it("is deterministic: the same seed reproduces the same sweep", () => {
    const a = searchCounterexamples({ count: 1500, seed: 99 });
    const b = searchCounterexamples({ count: 1500, seed: 99 });
    expect(a.casesRun).toBe(b.casesRun);
    expect(a.underCalls.length).toBe(b.underCalls.length);
    expect(a.classesSeen).toEqual(b.classesSeen);
    expect(a.strictOverCalls).toBe(b.strictOverCalls);
  });

  it("stays clean across several independent seeds (not a single lucky draw)", () => {
    for (const seed of [1, 42, 7, 2026]) {
      const r = searchCounterexamples({ count: 1500, seed });
      expect(r.underCalls, `seed ${seed}: ${r.underCalls.map((u) => u.rationale).join("\n")}`).toEqual([]);
    }
  });
});

describe("counterexample search — the INDEPENDENT true-class oracle", () => {
  it("derives the class from semantic facts, not from any surface string", () => {
    expect(independentTrueClass({ effect: "read" })).toBe("NULLIPOTENT");
    expect(independentTrueClass({ effect: "delete", committed: false })).toBe("NULLIPOTENT");
    expect(independentTrueClass({ effect: "create" })).toBe("REVERSIBLE");
    expect(independentTrueClass({ effect: "create", externalized: true })).toBe("COMPENSABLE");
    expect(independentTrueClass({ effect: "update", priorStateKnown: true })).toBe("REVERSIBLE");
    expect(independentTrueClass({ effect: "update" })).toBe("COMPENSABLE");
    expect(independentTrueClass({ effect: "send", externalized: true })).toBe("IRREVERSIBLE");
    expect(independentTrueClass({ effect: "send", externalized: false })).toBe("REVERSIBLE");
    expect(independentTrueClass({ effect: "pay", externalized: true })).toBe("IRREVERSIBLE");
    expect(independentTrueClass({ effect: "pay", externalized: false })).toBe("COMPENSABLE");
    expect(independentTrueClass({ effect: "delete", recoverable: false })).toBe("IRREVERSIBLE");
    expect(independentTrueClass({ effect: "delete", recoverable: true })).toBe("REVERSIBLE");
    expect(independentTrueClass({ effect: "delete", destructiveDdl: true, dropsDatabase: true, inOpenTransaction: true })).toBe("IRREVERSIBLE");
    expect(independentTrueClass({ effect: "delete", destructiveDdl: true, inOpenTransaction: true })).toBe("REVERSIBLE");
    expect(independentTrueClass({ effect: "delete", destructiveDdl: true, recoverable: true })).toBe("COMPENSABLE");
  });
});

describe("counterexample search — seeding from a recorded fault (memory tie-in)", () => {
  it("amplifies a seed case into mutated variants without ever introducing an under-call", () => {
    const seed: SearchCase = {
      action: { id: "seed-hard-delete", tool: "db.execute", params: { sql: "DELETE FROM orders WHERE id = 1" } },
      trueClass: "IRREVERSIBLE",
      profile: "seed.hard-delete",
    };
    const r = searchCounterexamples({ count: 300, seed: 5, seeds: [seed], mutationsPerSeed: 12 });
    expect(r.casesRun).toBe(300 + 1 + 12); // base draw + the seed + its mutations
    expect(r.underCalls).toEqual([]);
  });

  it("mutateCase preserves the true class and produces a distinct, still-correctly-classified action", () => {
    const seed: SearchCase = {
      action: { id: "m", tool: "db.execute", params: { sql: "DROP TABLE orders" } },
      trueClass: "IRREVERSIBLE",
      profile: "seed.drop",
    };
    let s = 12345;
    const rng = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const m = mutateCase(seed, rng);
    expect(m.trueClass).toBe("IRREVERSIBLE");
    expect(m.action.id).not.toBe(seed.action.id);
    // still resolves to (at least) the true class — the mutation is semantics-preserving
    expect(severityOf(effectiveClass(m.action))).toBeGreaterThanOrEqual(severityOf(m.trueClass));
  });
});

describe("counterexample search — DISCLOSED GAP in op-resolution (reported, never masked)", () => {
  // The Lean proof assumes op-resolution is correct; these are genuine under-calls in that layer,
  // surfaced by probing the assumption. They are NOT in the fair sweep. If any STOPS reproducing,
  // the gap was closed in classify.ts — promote it into the fair distribution.
  it("every catalogued gap genuinely under-calls (a real op-resolution bug), with a fault signature", () => {
    const found = reproduceKnownGaps();
    expect(found.length).toBe(KNOWN_OP_RESOLUTION_GAPS.length);
    for (const ce of found) {
      expect(ce.severityGap, ce.rationale).toBeGreaterThan(0);
      expect(severityOf(ce.assignedClass)).toBeLessThan(severityOf(ce.trueClass));
      expect(ce.faultSignature).toMatch(/^[0-9a-f]{32}$/); // shape-based signature → cross-references RecoveryMemory
      expect(ce.rationale).toContain("ROOT CAUSE:");
    }
  });

  it("a leading SQL comment hides a DROP behind a read-named tool → NULLIPOTENT (catastrophic 3-bucket miss)", () => {
    const a: AgentAction = { id: "x", tool: "db.query", params: { sql: "/* trace */ DROP TABLE orders" } };
    expect(effectiveClass(a)).toBe("NULLIPOTENT");
  });

  it("a multi-statement DML behind a leading SELECT → NULLIPOTENT (DELETE seen as a read)", () => {
    const a: AgentAction = { id: "y", tool: "db.query", params: { sql: "SELECT 1; DELETE FROM orders" } };
    expect(effectiveClass(a)).toBe("NULLIPOTENT");
  });
});
