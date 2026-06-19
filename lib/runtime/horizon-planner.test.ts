/**
 * Toffoli — tests for deterministic-first receding-horizon planning (MPC).
 *
 * These pin the load-bearing claims of the new mode:
 *   - STAGE 1 is the EXACT, FREE reversibility filter: every plan that would take an irreversible /
 *     uncertain action is pruned (reusing the same `isSpeculativeSafe` seam the gate uses), before the
 *     objective scores anything — the deterministic-first inversion;
 *   - STAGE 2 is a deterministic objective that, among equal-progress FEASIBLE plans, prefers the
 *     reversible route over a compensable one (and a low-blast action over a high-blast one);
 *   - the controller reaches the goal preferring reversible paths and NEVER executes an irreversible
 *     action (the safety invariant, measured at 0);
 *   - receding-horizon RE-PLANNING adapts to an unmodeled disturbance an open-loop plan would miss;
 *   - the executed trajectory is wholly recoverable through the existing `safeExecute` (back to baseline);
 *   - the kill-switch is absolute (nothing executes under a freeze), and a domain with only an
 *     irreversible route fails closed (no plan, nothing fired);
 *   - the whole thing is deterministic (identical decisions and traces across runs).
 */

import { describe, it, expect } from "vitest";
import { World } from "../exec/world";
import type { AgentAction } from "../engine/types";
import {
  decide,
  proposePlans,
  actionFeasibility,
  defaultStepCost,
  blastRadius,
  recedingHorizonControl,
  restituteEpisode,
  gateStepExecutor,
  type CandidateAction,
  type PlanningDomain,
  type StepExecutor,
} from "./horizon-planner";
import { classifyDeterministic } from "../engine/classify";
import { buildCloseScenario, closeDomain, observeClose, lateArrival, BACKUP_FEE, type CloseState } from "./horizon-scenario";

const clock = () => "2026-06-19T00:00:00Z";
const sandboxEnv = {} as NodeJS.ProcessEnv;

/** A pure step executor (no gate): fire the op and report it committed. Decouples the planner core from the gate in unit tests. */
function pureExecutor<W extends World>(): StepExecutor<W> {
  return async (op, world) => {
    const performed = op.fire(world);
    return { fired: true, committed: true, disposition: "committed-speculative", performed, reason: "pure test executor" };
  };
}

describe("actionFeasibility — the stage-1 seam reuses the deterministic floor", () => {
  const at = closeDomain.observe(buildCloseScenario().world);
  const lib = closeDomain.actions(at);
  const byId = (id: string) => lib.find((a) => a.action.id === id)!;

  it("rates the reversible soft-delete feasible", () => {
    const f = actionFeasibility(byId("del-t1"));
    expect(f.feasible).toBe(true);
    expect(f.class).toBe("REVERSIBLE");
  });
  it("rates the compensable backup charge feasible", () => {
    const f = actionFeasibility(byId("backup-vendor"));
    expect(f.feasible).toBe(true);
    expect(f.class).toBe("COMPENSABLE");
  });
  it("rates the IRREVERSIBLE drop-table INFEASIBLE", () => {
    const f = actionFeasibility(byId("drop-orders"));
    expect(f.feasible).toBe(false);
    expect(f.class).toBe("IRREVERSIBLE");
  });
});

describe("propose → STAGE-1 prune (exact, free) → STAGE-2 score", () => {
  it("prunes EVERY plan that contains the irreversible drop-table, before scoring", () => {
    const state = closeDomain.observe(buildCloseScenario().world);
    const d = decide(closeDomain, state);

    // something was proposed and something was pruned
    expect(d.proposed).toBeGreaterThan(0);
    expect(d.pruned.length).toBeGreaterThan(0);

    // EVERY pruned plan's culprit is the irreversible drop-table (the only infeasible action here)
    expect(d.pruned.every((p) => p.culprit.class === "IRREVERSIBLE" && p.culprit.action.id === "drop-orders")).toBe(true);
    // and EVERY plan that contained the drop-table was pruned (none survived)
    expect(d.feasible.some((p) => p.actions.some((a) => a.action.id === "drop-orders"))).toBe(false);
    // no surviving plan carries an irreversible/abstain class at all (the safety-envelope invariant)
    expect(d.feasible.every((p) => !p.classes.includes("IRREVERSIBLE") && !p.classes.includes("ABSTAIN"))).toBe(true);
  });

  it("the best plan reaches the goal with only reversible/compensable steps", () => {
    const state = closeDomain.observe(buildCloseScenario().world);
    const d = decide(closeDomain, state);
    expect(d.best).not.toBeNull();
    expect(d.best!.reachesGoal).toBe(true);
    expect(d.best!.classes.every((c) => c === "REVERSIBLE" || c === "COMPENSABLE")).toBe(true);
    expect(d.chosen).not.toBeNull();
  });

  it("STAGE 2 PREFERS the reversible route over an equal-progress compensable one", () => {
    // rows already clear; only the backup sub-goal remains → a head-to-head: write-file (REVERSIBLE)
    // vs charge-vendor (COMPENSABLE). Both make progress 1; the deterministic cost decides.
    const state = closeDomain.observe(buildCloseScenario([]).world);
    expect(closeDomain.distance(state)).toBe(1);
    const d = decide(closeDomain, state);

    const writeRoute = d.feasible.find((p) => p.actions[0]!.action.id === "backup-file")!;
    const payRoute = d.feasible.find((p) => p.actions[0]!.action.id === "backup-vendor")!;
    expect(writeRoute.progress).toBe(1);
    expect(payRoute.progress).toBe(1); // equal progress
    expect(writeRoute.cost).toBeLessThan(payRoute.cost); // but the reversible route is cheaper
    expect(writeRoute.score).toBeGreaterThan(payRoute.score);

    // so the planner chooses the REVERSIBLE local snapshot, not the compensable charge
    expect(d.chosen!.action.id).toBe("backup-file");
    expect(classifyDeterministic(d.chosen!.action)!.class).toBe("REVERSIBLE");
  });

  it("proposePlans yields only strictly-progressing sequences and terminates", () => {
    const state = closeDomain.observe(buildCloseScenario().world);
    const plans = proposePlans(closeDomain, state, 8).filter((p) => p.length > 0);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      let s = state;
      let prev = closeDomain.distance(s);
      for (const a of plan) {
        const next = closeDomain.distance(a.predict(s));
        expect(next).toBeLessThan(prev); // strict progress every step
        prev = next;
        s = a.predict(s);
      }
    }
  });
});

describe("the receding-horizon controller reaches the goal preferring reversible paths", () => {
  it("drives the world to the goal in safe steps, never taking the irreversible shortcut", async () => {
    const { world } = buildCloseScenario();
    const ep = await recedingHorizonControl(closeDomain, world, { env: sandboxEnv, clock, runId: "test-A" });

    expect(ep.reachedGoal).toBe(true);
    expect(ep.stop).toBe("goal");
    expect(ep.irreversibleExecuted).toBe(0); // THE safety invariant, measured
    expect(ep.executedActions).toHaveLength(4); // 3 soft-deletes + 1 backup snapshot
    // every executed action is reversible or compensable — provably recoverable
    expect(ep.executedActions.every((a) => ["REVERSIBLE", "COMPENSABLE"].includes(classifyDeterministic(a)!.class))).toBe(true);

    const snap = world.snapshot();
    expect(snap.tables).toContain("orders"); // the table was NEVER dropped (irreversible shortcut refused)
    expect(snap.outbox).toHaveLength(0); // no irreversible external send
    expect(observeClose(snap).live.size).toBe(0); // all stale rows cleared
    // each step really went through the speculative gate (committed-speculative), not a bare mutation
    expect(ep.iterations.every((i) => i.execution?.disposition === "committed-speculative")).toBe(true);
  });

  it("is deterministic — identical decision and trace across runs", async () => {
    const d1 = decide(closeDomain, closeDomain.observe(buildCloseScenario().world));
    const d2 = decide(closeDomain, closeDomain.observe(buildCloseScenario().world));
    expect(d2.best!.actions.map((a) => a.action.id)).toEqual(d1.best!.actions.map((a) => a.action.id));
    expect(d2.best!.score).toBe(d1.best!.score);

    const ep1 = await recedingHorizonControl(closeDomain, buildCloseScenario().world, { env: sandboxEnv, clock });
    const ep2 = await recedingHorizonControl(closeDomain, buildCloseScenario().world, { env: sandboxEnv, clock });
    expect(ep2.executedActions.map((a) => a.id)).toEqual(ep1.executedActions.map((a) => a.id));
  });
});

describe("re-plan ADAPTS when the observed effect diverges from the prediction", () => {
  it("cleans an unmodeled late-arriving row an open-loop plan would have missed", async () => {
    // the open-loop plan computed once at the start is 4 steps long
    const openLoop = decide(closeDomain, closeDomain.observe(buildCloseScenario().world));
    expect(openLoop.best!.actions).toHaveLength(4);

    // with a disturbance (a stale row 't9' arrives after step 0), the closed-loop controller adapts
    const { world } = buildCloseScenario();
    const ep = await recedingHorizonControl(closeDomain, world, { env: sandboxEnv, clock, onAfterStep: lateArrival("t9", 0), runId: "test-B" });

    expect(ep.reachedGoal).toBe(true);
    expect(ep.divergences).toBeGreaterThanOrEqual(1); // observed ≠ predicted at least once
    expect(ep.steps).toBe(5); // one MORE step than the 4-step open-loop plan — it adapted
    // the executed actions are the GENUINE world actions (their real ids/targets), so identify the
    // late arrival by the row it touched, not the candidate descriptor id.
    expect(ep.executedActions.some((a) => a.target?.id === "orders:t9")).toBe(true); // it cleaned the late arrival
    expect(observeClose(world.snapshot()).live.size).toBe(0); // goal genuinely reached on the true world
    expect(ep.irreversibleExecuted).toBe(0); // still never irreversible
  });

  it("records the divergence at the exact step the disturbance lands", async () => {
    const { world } = buildCloseScenario();
    const ep = await recedingHorizonControl(closeDomain, world, { env: sandboxEnv, clock, onAfterStep: lateArrival("t9", 0) });
    const step0 = ep.iterations[0]!;
    expect(step0.diverged).toBe(true);
    expect(step0.nextObservedDistance).toBe(step0.predictedDistance + 1); // the extra unmodeled row
  });
});

describe("episode restitution through the existing safeExecute", () => {
  it("undoes the WHOLE executed trajectory back to the pre-episode baseline", async () => {
    const { world } = buildCloseScenario();
    const baseline = world.snapshot();
    const ep = await recedingHorizonControl(closeDomain, world, { env: sandboxEnv, clock });
    expect(ep.reachedGoal).toBe(true);

    const report = restituteEpisode(ep.executedActions, world, { env: sandboxEnv, clock });
    expect(report.restored).toBe(ep.executedActions.length); // every executed step undone
    expect(report.fabricationCheck.pass).toBe(true); // every reported restoration is journal-confirmed
    expect(report.compensationFailed).toBe(0);
    expect(report.blocked).toBe(0);
    expect(report.unsupported).toBe(0);

    const after = world.snapshot();
    expect(after.rows).toEqual(baseline.rows); // stale rows restored from trash
    expect(after.files).toEqual(baseline.files); // backup snapshot deleted
    expect(after.ledgerUsd).toBe(baseline.ledgerUsd);
  });
});

describe("fail-closed: the kill-switch and an irreversible-only domain", () => {
  it("executes NOTHING under a freeze and leaves the world untouched", async () => {
    const { world } = buildCloseScenario();
    const before = JSON.stringify(world.snapshot());
    const env = { TOFFOLI_EXECUTE_DISABLED: "1" } as NodeJS.ProcessEnv;
    const ep = await recedingHorizonControl(closeDomain, world, { env, clock, maxSteps: 6 });
    expect(ep.executedActions).toHaveLength(0);
    expect(ep.reachedGoal).toBe(false);
    expect(JSON.stringify(world.snapshot())).toBe(before); // zero mutation
  });

  it("refuses to plan when the only route to the goal is irreversible", async () => {
    // a tiny domain whose ONLY progressing action is an irreversible external send.
    type S = { sent: boolean };
    const sendOnly: CandidateAction<World, S> = {
      action: { id: "notify", tool: "email.send", op: "send", target: { kind: "email", externalized: true } },
      fire: (w) => w.sendEmail("client@acme.com", "done"),
      predict: () => ({ sent: true }),
    };
    const domain: PlanningDomain<World, S> = {
      observe: (w) => ({ sent: w.snapshot().outbox.length > 0 }),
      actions: () => [sendOnly],
      distance: (s) => (s.sent ? 0 : 1),
    };
    const world = new World();

    // decide: the only progressing plan is pruned → no feasible plan, nothing chosen
    const d = decide(domain, domain.observe(world));
    expect(d.proposed).toBe(1);
    expect(d.feasible).toHaveLength(0);
    expect(d.best).toBeNull();
    expect(d.chosen).toBeNull();

    // controller stops fail-closed without firing the irreversible send
    const ep = await recedingHorizonControl(domain, world, { env: sandboxEnv, clock });
    expect(ep.stop).toBe("no-feasible-plan");
    expect(ep.reachedGoal).toBe(false);
    expect(world.snapshot().outbox).toHaveLength(0); // the irreversible send was never fired
  });
});

describe("the deterministic stage-2 cost (irreversibility class × blast radius)", () => {
  it("scores reversible cheaper than an equal-blast compensable action", () => {
    const reversible: AgentAction = { id: "r", tool: "fs.write", op: "create", target: { kind: "file", id: "x" } };
    const compensable: AgentAction = { id: "c", tool: "stripe.charge", op: "pay", params: { amountUsd: 1 }, target: { kind: "payment", id: "v", externalized: false } };
    const rc = classifyDeterministic(reversible);
    const cc = classifyDeterministic(compensable);
    expect(defaultStepCost(reversible, rc)).toBeLessThan(defaultStepCost(compensable, cc));
  });

  it("blast radius scales with money moved and is large for external reach", () => {
    expect(blastRadius({ id: "a", tool: "stripe.charge", op: "pay", params: { amountUsd: 250 } })).toBe(250);
    expect(blastRadius({ id: "b", tool: "fs.write", op: "create", target: { kind: "file", id: "x" } })).toBe(1);
    expect(blastRadius({ id: "c", tool: "email.send", op: "send" })).toBe(100);
  });

  it("an ABSTAIN (null classification) costs +Infinity so it can never win scoring", () => {
    const abstain: AgentAction = { id: "u", tool: "db.execute", op: "update", target: { kind: "db.row", id: "r" } };
    expect(classifyDeterministic(abstain)).toBeNull();
    expect(defaultStepCost(abstain, null)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("the gate step executor commits a feasible step and refuses an irreversible one", () => {
  it("commits a reversible action and returns the genuine performed action", async () => {
    const world = new World();
    world.seedTable("orders");
    world.seedRow("orders", "t1", { is_stale: true });
    const exec = gateStepExecutor<World>({ env: sandboxEnv, clock });
    const op: CandidateAction<World, CloseState> = {
      action: { id: "del-t1", tool: "db.execute", op: "delete", params: { sql: "DELETE FROM orders WHERE id = 't1'" }, target: { kind: "db.row", id: "orders:t1", recoverable: true } },
      fire: (w) => w.softDeleteRow("orders", "t1"),
      predict: (s) => s,
    };
    const r = await exec(op, world);
    expect(r.committed).toBe(true);
    expect(r.disposition).toBe("committed-speculative");
    expect(r.performed).toBeDefined();
    expect(world.snapshot().rows["orders:t1"]).toBeUndefined(); // really soft-deleted
  });

  it("does NOT commit an irreversible action (the gate escalates it)", async () => {
    const world = new World();
    const exec = gateStepExecutor<World>({ env: sandboxEnv, clock });
    const op: CandidateAction<World, { sent: boolean }> = {
      action: { id: "notify", tool: "email.send", op: "send", target: { kind: "email", externalized: true } },
      fire: (w) => w.sendEmail("client@acme.com", "x"),
      predict: (s) => s,
    };
    const r = await exec(op, world);
    expect(r.committed).toBe(false);
    expect(r.disposition).toBe("escalated");
    expect(world.snapshot().outbox).toHaveLength(0); // never fired
  });
});

// keep the pure-executor import meaningful: the planner core runs with ANY executor, not just the gate.
describe("the planner core is decoupled from the gate (pure executor)", () => {
  it("reaches the goal with an injected pure executor too", async () => {
    const { world } = buildCloseScenario();
    const ep = await recedingHorizonControl(closeDomain, world, { executor: pureExecutor<World>(), env: sandboxEnv, clock });
    expect(ep.reachedGoal).toBe(true);
    expect(ep.executedActions).toHaveLength(4);
    expect(BACKUP_FEE).toBeGreaterThan(0); // sanity: the compensable route has a real, non-zero blast
  });
});
