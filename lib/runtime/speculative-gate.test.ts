/**
 * Toffoli — tests for reversibility-gated speculative execution.
 *
 * These pin the load-bearing invariants of the new execution mode:
 *   - the deterministic floor IS the speculation feasibility predicate (REVERSIBLE/COMPENSABLE only);
 *   - a permitted speculation COMMITS and a rejected one ROLLS BACK losslessly (verified vs baseline);
 *   - IRREVERSIBLE and ABSTAIN are PROVABLY never speculated — even when the authoritative tier WOULD
 *     have permitted them (the block is at the cheap tier, not the oracle);
 *   - the kill-switch is absolute (nothing fires under a freeze);
 *   - the cascade-telemetry slice (alpha / disagreementRate / losslessViolations) is exactly what the
 *     fixed scenario produces, and the lossless-violation count is 0;
 *   - the calibration is a Wilson lower bound, multiplicity-corrected, and conservative at small n.
 */

import { describe, it, expect } from "vitest";
import { World } from "../exec/world";
import type { AgentAction } from "../engine/types";
import {
  isSpeculativeSafe,
  speculativeExecute,
  cascadeTelemetry,
  defaultPermissionCheck,
  spendCapPolicy,
  composePolicies,
  ALLOW_ALL_POLICY,
  SPECULATIVE_REGIME,
  SPECULATIVE_LOCUS,
  type PermissionCheck,
  type SpeculativeOp,
  type SpeculativePermissionPolicy,
} from "./speculative-gate";
import { calibrateSpeculation, normalQuantile, speculationCurve, type AcceptanceObservation } from "./speculative-calibrate";
import { buildSpeculativeScenario, scenarioPolicy } from "./speculative-scenario";
import { KILL_SWITCH_ENV } from "./mode";

const clock = () => "2026-06-19T00:00:00Z";
const sandboxEnv = {} as NodeJS.ProcessEnv;

// Action descriptors spanning the classes.
const reversibleDelete: AgentAction = { id: "del", tool: "db.execute", op: "delete", params: { sql: "DELETE FROM orders WHERE id='t1'" }, target: { kind: "db.row", id: "orders:t1", recoverable: true } };
const compensableCharge: AgentAction = { id: "chg", tool: "stripe.charge", op: "pay", params: { amountUsd: 500 }, target: { kind: "payment", id: "vendor", externalized: false } };
const irreversibleSend: AgentAction = { id: "snd", tool: "email.send", op: "send", target: { kind: "email", externalized: true } };
const abstainUpdate: AgentAction = { id: "upd", tool: "db.execute", op: "update", target: { kind: "db.row", id: "orders:9" } };
const nullipotentRead: AgentAction = { id: "rd", tool: "db.query", op: "read", params: { sql: "SELECT * FROM orders" } };

const permitAll: PermissionCheck = () => ({ permit: true, reason: "test stub permits everything", source: "policy" });

describe("isSpeculativeSafe — the deterministic feasibility predicate (stage-1 seam)", () => {
  it("rates REVERSIBLE speculatable with an exact rollback", () => {
    const f = isSpeculativeSafe(reversibleDelete);
    expect(f.speculative).toBe(true);
    expect(f.class).toBe("REVERSIBLE");
    expect(f.rollback).toBe("exact");
  });
  it("rates COMPENSABLE speculatable with a semantic rollback", () => {
    const f = isSpeculativeSafe(compensableCharge);
    expect(f.speculative).toBe(true);
    expect(f.class).toBe("COMPENSABLE");
    expect(f.rollback).toBe("semantic");
  });
  it("HARD-BLOCKS IRREVERSIBLE from ever speculating", () => {
    const f = isSpeculativeSafe(irreversibleSend);
    expect(f.speculative).toBe(false);
    expect(f.class).toBe("IRREVERSIBLE");
    expect(f.rollback).toBe("none");
  });
  it("fails closed on an ABSTAIN (uncertainty is not a licence to speculate)", () => {
    const f = isSpeculativeSafe(abstainUpdate);
    expect(f.speculative).toBe(false);
    expect(f.class).toBe("ABSTAIN");
    expect(f.classification).toBeNull();
  });
  it("does not speculate a NULLIPOTENT read (nothing to undo, runs directly)", () => {
    const f = isSpeculativeSafe(nullipotentRead);
    expect(f.speculative).toBe(false);
    expect(f.class).toBe("NULLIPOTENT");
  });
});

describe("the commit path", () => {
  it("fires a permitted speculation optimistically and KEEPS it", async () => {
    const world = new World();
    const op: SpeculativeOp<World> = { action: compensableCharge, fire: (w) => w.charge("vendor", 500) };
    const r = await speculativeExecute([op], world, { permissionCheck: permitAll, env: sandboxEnv, clock });
    const o = r.outcomes[0]!;
    expect(o.disposition).toBe("committed-speculative");
    expect(o.fired).toBe(true);
    expect(o.speculated).toBe(true);
    expect(world.snapshot().ledgerUsd).toBe(500); // kept, NOT refunded
    expect(r.speculationAcceptanceRate).toBe(1);
    expect(r.misSpeculationRestitutionCost).toBe(0);
  });
});

describe("the rollback path", () => {
  it("rolls back a rejected speculation LOSSLESSLY (verified vs the pre-fire baseline)", async () => {
    const world = new World();
    const baseline = world.snapshot();
    const op: SpeculativeOp<World> = { action: compensableCharge, fire: (w) => w.charge("vendor", 500) };
    // The reversibility oracle PROCEEDs (compensable), but the spend-cap POLICY rejects $500 → rollback.
    const check = defaultPermissionCheck({ policy: spendCapPolicy(100), clock });
    const r = await speculativeExecute([op], world, { permissionCheck: check, env: sandboxEnv, clock });
    const o = r.outcomes[0]!;
    expect(o.disposition).toBe("rolled-back");
    expect(o.fired).toBe(true);
    expect(o.rollback?.restoredToBaseline).toBe(true);
    expect(o.rollback?.lossless).toBe(true);
    expect(o.rollback?.report.fabricationCheck.pass).toBe(true);
    expect(world.snapshot().ledgerUsd).toBe(baseline.ledgerUsd); // money put back
    expect(r.misSpeculationRestitutionCost).toBe(1);
  });
});

describe("IRREVERSIBLE / ABSTAIN are provably NEVER speculated (fail-closed)", () => {
  it("never fires an IRREVERSIBLE send, even when the authoritative tier WOULD permit it", async () => {
    const world = new World();
    let fired = false;
    const op: SpeculativeOp<World> = {
      action: irreversibleSend,
      fire: (w) => {
        fired = true;
        return w.sendEmail("client@acme.com", "x");
      },
    };
    // permitAll would say yes — the block must come from the cheap reversibility tier, not the oracle.
    const r = await speculativeExecute([op], world, { permissionCheck: permitAll, env: sandboxEnv, clock });
    const o = r.outcomes[0]!;
    expect(o.disposition).toBe("escalated");
    expect(o.fired).toBe(false);
    expect(fired).toBe(false); // the thunk was never invoked
    expect(world.snapshot().outbox).toHaveLength(0); // no external send happened
    expect(r.escalations).toHaveLength(1);
    expect(r.telemetry.losslessViolations).toBe(0);
  });

  it("never speculates an action the floor ABSTAINED on", async () => {
    const world = new World();
    let fired = false;
    const op: SpeculativeOp<World> = {
      action: abstainUpdate,
      fire: (w) => {
        fired = true;
        return w.softDeleteRow("orders", "9");
      },
    };
    const r = await speculativeExecute([op], world, { permissionCheck: permitAll, env: sandboxEnv, clock });
    expect(r.outcomes[0]!.disposition).toBe("escalated");
    expect(fired).toBe(false);
  });
});

describe("the kill-switch is absolute", () => {
  it("fires NOTHING under a freeze — every action is plan-only", async () => {
    const { world, ops } = buildSpeculativeScenario();
    const before = world.snapshot();
    const env = { [KILL_SWITCH_ENV]: "1" } as NodeJS.ProcessEnv;
    const r = await speculativeExecute(ops, world, { permissionCheck: defaultPermissionCheck({ policy: scenarioPolicy, env, clock }), env, clock });
    expect(r.mode.killSwitchEngaged).toBe(true);
    expect(r.outcomes.every((o) => o.disposition === "plan-only")).toBe(true);
    expect(r.outcomes.every((o) => !o.fired)).toBe(true);
    expect(world.snapshot()).toEqual(before); // zero mutation
  });
});

describe("the cascade-telemetry slice (the suite contract)", () => {
  it("emits exactly what the fixed 12-action scenario produces, with 0 lossless violations", async () => {
    const { world, ops } = buildSpeculativeScenario();
    const check = defaultPermissionCheck({ policy: scenarioPolicy, clock });
    const r = await speculativeExecute(ops, world, { permissionCheck: check, env: sandboxEnv, clock });
    const t = r.telemetry;

    expect(t.regime).toBe(SPECULATIVE_REGIME);
    expect(t.locus).toBe(SPECULATIVE_LOCUS);
    expect(t.n).toBe(12);
    expect(t.counts["committed-speculative"]).toBe(7); // 5 deletes + 2 under-cap charges
    expect(t.counts["rolled-back"]).toBe(1); // the over-cap charge
    expect(t.counts.escalated).toBe(2); // two external sends
    expect(t.counts["ran-nullipotent"]).toBe(2); // two reads

    expect(t.alpha).toBeCloseTo(9 / 12, 10); // committed + reads, resolved losslessly on the fast path
    expect(t.disagreementRate).toBeCloseTo(1 / 12, 10); // exactly the one mis-speculation
    expect(t.comparable).toBe(12);
    expect(t.losslessViolations).toBe(0);

    expect(r.speculationAcceptanceRate).toBeCloseTo(7 / 8, 10); // 7 of 8 optimistic fires permitted
    expect(r.misSpeculationRestitutionCost).toBe(1);

    // every realized rollback genuinely restored the baseline
    expect(r.outcomes.filter((o) => o.disposition === "rolled-back").every((o) => o.rollback?.lossless)).toBe(true);
    // and no external send was ever fired on a guess
    expect(world.snapshot().outbox).toHaveLength(0);
  });

  it("counts a permitted speculation as agreement and a rejected one as disagreement", () => {
    const committed = cascadeTelemetry([
      { actionId: "a", disposition: "committed-speculative", class: "REVERSIBLE", feasibility: isSpeculativeSafe(reversibleDelete), fired: true, speculated: true, fastPermit: true, authoritative: { permit: true, reason: "", source: "oracle+policy" }, bothTiersRan: true, reason: "" },
    ]);
    expect(committed.disagreementRate).toBe(0);
    const rejected = cascadeTelemetry([
      { actionId: "a", disposition: "rolled-back", class: "COMPENSABLE", feasibility: isSpeculativeSafe(compensableCharge), fired: true, speculated: true, fastPermit: true, authoritative: { permit: false, reason: "", source: "policy" }, bothTiersRan: true, reason: "", rollback: { report: { restored: 1 } as never, restoredToBaseline: true, lossless: true } },
    ]);
    expect(rejected.disagreementRate).toBe(1);
    expect(rejected.losslessViolations).toBe(0);
  });

  it("flags a lossless VIOLATION if a rollback fails to restore the baseline", () => {
    const t = cascadeTelemetry([
      { actionId: "a", disposition: "rolled-back", class: "COMPENSABLE", feasibility: isSpeculativeSafe(compensableCharge), fired: true, speculated: true, fastPermit: true, authoritative: { permit: false, reason: "", source: "policy" }, bothTiersRan: true, reason: "", rollback: { report: { restored: 0 } as never, restoredToBaseline: false, lossless: false } },
    ]);
    expect(t.losslessViolations).toBe(1);
  });
});

describe("the acceptance-vs-restitution-cost curve (parameter sweep over a FIXED scenario)", () => {
  it("widening eligibility raises restitution cost and lowers acceptance; disagreement is stable; lossless stays 0", async () => {
    const check = defaultPermissionCheck({ policy: scenarioPolicy, clock });
    const curve = await speculationCurve(
      buildSpeculativeScenario,
      [
        { label: "none", speculateClasses: [] },
        { label: "rev", speculateClasses: ["REVERSIBLE"] },
        { label: "rev+comp", speculateClasses: ["REVERSIBLE", "COMPENSABLE"] },
      ],
      { permissionCheck: check, env: sandboxEnv, clock },
    );
    const [none, rev, full] = curve;

    // restitution cost monotonic non-decreasing as the eligible set widens
    expect(none!.misSpeculationRestitutionCost).toBe(0);
    expect(rev!.misSpeculationRestitutionCost).toBe(0);
    expect(full!.misSpeculationRestitutionCost).toBe(1);

    // acceptance: REVERSIBLE-only fires only safe guesses (1.0); the full set takes the over-cap rejection (< 1.0)
    expect(rev!.speculationAcceptanceRate).toBe(1);
    expect(full!.speculationAcceptanceRate).toBeLessThan(rev!.speculationAcceptanceRate);

    // disagreement is intrinsic to the classifier vs the authority — stable across operating policies
    expect(none!.disagreementRate).toBeCloseTo(full!.disagreementRate, 10);
    expect(rev!.disagreementRate).toBeCloseTo(full!.disagreementRate, 10);

    // the safety-envelope invariant holds for EVERY operating policy
    expect(curve.every((p) => p.losslessViolations === 0)).toBe(true);
  });
});

describe("calibration — Wilson lower bound, multiplicity-corrected, conservative at small n", () => {
  it("derives the break-even from the cost model and Bonferroni-corrects across classes", () => {
    const obs: AcceptanceObservation[] = [
      ...Array.from({ length: 5 }, () => ({ class: "REVERSIBLE" as const, permitted: true })),
      { class: "COMPENSABLE", permitted: true },
      { class: "COMPENSABLE", permitted: true },
      { class: "COMPENSABLE", permitted: false },
    ];
    const calib = calibrateSpeculation(obs, { latencySaved: 5, rollbackCost: 1 });
    expect(calib.breakEven).toBeCloseTo(1 / 6, 10); // rollbackCost / (latencySaved + rollbackCost)
    expect(calib.perClassAlpha).toBeCloseTo(0.05 / 2, 10); // Bonferroni across the 2 classes with data

    for (const c of calib.perClass) {
      if (c.nObs > 0) expect(c.wilsonLower).toBeLessThanOrEqual(c.acceptHat); // a lower bound, never the flattering point estimate
    }
    // both classes clear the (low) break-even bar at this n
    expect(calib.speculateClasses.sort()).toEqual(["COMPENSABLE", "REVERSIBLE"]);
  });

  it("is CONSERVATIVE at tiny n — refuses to speculate when the lower bound can't clear a high bar", () => {
    const obs: AcceptanceObservation[] = [{ class: "COMPENSABLE", permitted: true }]; // n=1, all permitted
    const calib = calibrateSpeculation(obs, { latencySaved: 1, rollbackCost: 1 }); // break-even 0.5
    expect(calib.breakEven).toBeCloseTo(0.5, 10);
    const comp = calib.perClass.find((c) => c.class === "COMPENSABLE")!;
    expect(comp.acceptHat).toBe(1); // the point estimate is a flattering 100%
    expect(comp.wilsonLower).toBeLessThan(0.5); // but the lower bound does not clear the bar
    expect(calib.speculateClasses).not.toContain("COMPENSABLE"); // so we DON'T speculate it
  });

  it("normalQuantile matches the standard z values", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.96, 2);
    expect(normalQuantile(0.95)).toBeCloseTo(1.645, 2);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
  });
});

describe("default permission check composes the oracle and the orthogonal policy", () => {
  it("permits a reversible action the oracle PROCEEDs on and the policy allows", async () => {
    const check = defaultPermissionCheck({ policy: ALLOW_ALL_POLICY, clock });
    const v = await check(reversibleDelete);
    expect(v.permit).toBe(true);
    expect(v.source).toBe("oracle+policy");
  });
  it("rejects an irreversible action at the oracle leg before the policy is consulted", async () => {
    const check = defaultPermissionCheck({ policy: ALLOW_ALL_POLICY, clock });
    const v = await check(irreversibleSend);
    expect(v.permit).toBe(false);
    expect(v.source).toBe("oracle");
  });
});

describe("composePolicies — AND over orthogonal policies (first reject wins and names itself)", () => {
  // A second concrete policy on a dimension the reversibility floor (and the spend cap) can't see:
  // the recipient. This is exactly the kind of orthogonal constraint the compose helper exists to AND in.
  const recipientAllowlist = (allowed: string[]): SpeculativePermissionPolicy => ({
    permits: (action) => {
      const to = String(action.target?.id);
      return allowed.includes(to)
        ? { permit: true, reason: `recipient '${to}' on the allowlist` }
        : { permit: false, reason: `recipient '${to}' not on the allowlist` };
    },
  });

  it("permits only when EVERY composed policy permits", () => {
    // $500 ≤ $1000 cap AND recipient 'vendor' allowed → both legs permit.
    const policy = composePolicies(spendCapPolicy(1000), recipientAllowlist(["vendor"]));
    const v = policy.permits(compensableCharge);
    expect(v.permit).toBe(true);
    expect(v.reason).toBe("all policies permit");
  });

  it("the FIRST rejecting policy wins and names itself", () => {
    // Both legs would reject; the spend cap is listed first, so its reason is the one surfaced.
    const capFirst = composePolicies(spendCapPolicy(100), recipientAllowlist(["someone-else"]));
    const v1 = capFirst.permits(compensableCharge);
    expect(v1.permit).toBe(false);
    expect(v1.reason).toContain("spend cap");
    expect(v1.reason).not.toContain("allowlist"); // short-circuited before the second leg

    // Reorder so the cap permits ($500 ≤ $1000): now the allowlist is the first (and only) rejecter.
    const allowlistDecides = composePolicies(spendCapPolicy(1000), recipientAllowlist(["someone-else"]));
    const v2 = allowlistDecides.permits(compensableCharge);
    expect(v2.permit).toBe(false);
    expect(v2.reason).toContain("not on the allowlist");
  });

  it("an empty composition permits vacuously (the AND identity), like ALLOW_ALL", () => {
    expect(composePolicies().permits(compensableCharge).permit).toBe(true);
    expect(composePolicies().permits(irreversibleSend).permit).toBe(true);
  });

  it("drives the authoritative tier — a composed reject surfaces as a policy-sourced rollback", async () => {
    const world = new World();
    const baseline = world.snapshot();
    const op: SpeculativeOp<World> = { action: compensableCharge, fire: (w) => w.charge("vendor", 500) };
    // Oracle PROCEEDs (compensable); the COMPOSED policy rejects on the cap → speculate-then-rollback.
    const check = defaultPermissionCheck({ policy: composePolicies(spendCapPolicy(100), recipientAllowlist(["vendor"])), clock });
    const r = await speculativeExecute([op], world, { permissionCheck: check, env: sandboxEnv, clock });
    const o = r.outcomes[0]!;
    expect(o.disposition).toBe("rolled-back");
    expect(o.authoritative?.source).toBe("policy");
    expect(o.rollback?.lossless).toBe(true);
    expect(world.snapshot().ledgerUsd).toBe(baseline.ledgerUsd); // money put back
  });
});
