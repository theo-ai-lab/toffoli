/**
 * Toffoli — the DETERMINISTIC-FIRST RECEDING-HORIZON PLANNING demo. `npm run plan`.
 *
 * Shows the whole control story end-to-end on real sandbox state:
 *   1. PROPOSE → PRUNE → SCORE at the first state: the candidate action library, the IRREVERSIBLE
 *      `DROP TABLE` shortcut pruned for FREE at stage 1, and the deterministic objective preferring the
 *      reversible route.
 *   2. The full receding-horizon EPISODE: one safe step per iteration, re-observe, re-plan, to the goal.
 *   3. RE-PLAN ADAPTS: a second episode with an unmodeled disturbance (a late stale row) — the observed
 *      effect diverges from the model's prediction and the controller adapts, where an open-loop plan
 *      would have stopped short.
 *   4. EPISODE RESTITUTION: the whole executed trajectory undone through the existing `safeExecute`,
 *      verified back to the pre-episode baseline (the payoff of the stage-1 prune — it was all recoverable).
 *
 * Deterministic and offline (no key, no network). The only mutations are to the in-memory sandbox.
 */

import type { World } from "../exec/world";
import { decide, recedingHorizonControl, restituteEpisode, actionFeasibility, type HorizonIteration } from "./horizon-planner";
import { buildCloseScenario, closeDomain, lateArrival, type CloseState } from "./horizon-scenario";

const clock = () => "2026-06-19T00:00:00Z";
const sandboxEnv = {} as NodeJS.ProcessEnv;

function recoverableMatches(a: ReturnType<World["snapshot"]>, b: ReturnType<World["snapshot"]>): boolean {
  const norm = (o: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y))));
  return norm(a.files) === norm(b.files) && norm(a.rows) === norm(b.rows) && a.ledgerUsd === b.ledgerUsd;
}

function traceRow(it: HorizonIteration<World, CloseState>): string {
  const mark = it.diverged ? "⚠ DIVERGED" : "· on-model";
  const chosen = it.chosen ? (it.chosen.label ?? it.chosen.action.id) : "(no feasible plan)";
  const disp = it.execution ? it.execution.disposition : "—";
  return `    step ${it.step}  dist ${it.observedDistance}→${it.nextObservedDistance}  predicted ${it.predictedDistance}  [${mark}]  ${disp.padEnd(22)} ${chosen}`;
}

async function main(): Promise<void> {
  console.log(`  ${"=".repeat(98)}`);
  console.log("  TOFFOLI — DETERMINISTIC-FIRST RECEDING-HORIZON PLANNING  (stage-1 prune is EXACT + FREE: the inversion)");
  console.log(`  ${"=".repeat(98)}`);

  // ── 1 · propose → prune → score at the first state ──
  const first = buildCloseScenario();
  const state0 = closeDomain.observe(first.world);
  console.log(`\n  GOAL: clear stale rows {${[...state0.live].sort().join(", ")}} and take a period backup  (start distance ${closeDomain.distance(state0)})`);
  console.log("\n  CANDIDATE ACTION LIBRARY at the first state (stage-1 reversibility verdict):");
  for (const a of closeDomain.actions(state0)) {
    const f = actionFeasibility(a);
    console.log(`    ${f.feasible ? "✓ feasible " : "✗ PRUNED   "} ${String(f.class).padEnd(12)} ${a.label ?? a.action.id}`);
  }

  const decision = decide(closeDomain, state0);
  console.log(`\n  PROPOSE: ${decision.proposed} candidate plan(s) enumerated toward the goal.`);
  console.log(`  STAGE 1 (exact, FREE reversibility prune): ${decision.pruned.length} plan(s) dropped — every plan that would take an irreversible/uncertain action.`);
  const droppedByDrop = decision.pruned.filter((p) => p.culprit.class === "IRREVERSIBLE").length;
  console.log(`    └─ ${droppedByDrop} dropped because they contained the IRREVERSIBLE \`DROP TABLE\` shortcut (zero model spend to know this).`);
  console.log(`  STAGE 2 (deterministic objective: progress − irreversibility/blast cost): ${decision.feasible.length} survivor(s) scored.`);
  const best = decision.best!;
  console.log(`    best plan (score ${best.score}, cost ${best.cost}, reaches goal=${best.reachesGoal}): ${best.actions.map((a) => a.action.id).join(" → ")}`);
  console.log(`    classes along the best plan: [${best.classes.join(", ")}]  ← no IRREVERSIBLE, backup via the REVERSIBLE local snapshot (cheaper than the compensable charge)`);
  console.log(`  MPC executes only the FIRST action this iteration: ${decision.chosen!.label ?? decision.chosen!.action.id}`);

  // ── 2 · the full receding-horizon episode (no disturbance) ──
  console.log("\n  ── EPISODE A — receding-horizon control to the goal (no disturbance) ──");
  const a = buildCloseScenario();
  const baselineA = a.world.snapshot();
  const epA = await recedingHorizonControl(closeDomain, a.world, { env: sandboxEnv, clock, runId: "plan-demo-A", onIteration: (it) => console.log(traceRow(it)) });
  console.log(`    reached goal: ${epA.reachedGoal} in ${epA.steps} safe step(s); irreversible actions executed: ${epA.irreversibleExecuted} (MUST be 0); total blast/irreversibility cost: ${epA.totalCost}`);
  console.log(`    outbox after run: ${a.world.snapshot().outbox.length}  ·  table dropped: ${!a.world.snapshot().tables.includes("orders")}  (the irreversible shortcut was never taken)`);

  // ── 4 · episode restitution through the existing safeExecute ──
  const restitution = restituteEpisode(epA.executedActions, a.world, { env: sandboxEnv, clock });
  const backToBaseline = recoverableMatches(a.world.snapshot(), baselineA);
  console.log(`    EPISODE RESTITUTION via safeExecute: restored ${restitution.restored} step(s); fabrication-check ${restitution.fabricationCheck.pass ? "PASS" : "FAIL"}; back to pre-episode baseline: ${backToBaseline}`);

  // ── 3 · re-plan adapts to an unmodeled disturbance ──
  console.log("\n  ── EPISODE B — an unmodeled disturbance (a late stale row 't9' arrives after step 0) ──");
  const b = buildCloseScenario();
  const epB = await recedingHorizonControl(closeDomain, b.world, { env: sandboxEnv, clock, runId: "plan-demo-B", onAfterStep: lateArrival("t9", 0), onIteration: (it) => console.log(traceRow(it)) });
  console.log(`    reached goal: ${epB.reachedGoal} in ${epB.steps} safe step(s); divergences observed (observed ≠ predicted): ${epB.divergences}`);
  console.log(`    the controller cleaned the late 't9' it never modeled — receding horizon re-planned from the truth; an open-loop plan would have stopped one row short.`);

  // ── kill-switch ──
  const frozen = buildCloseScenario();
  const before = JSON.stringify(frozen.world.snapshot());
  const epFrozen = await recedingHorizonControl(closeDomain, frozen.world, { env: { TOFFOLI_EXECUTE_DISABLED: "1" } as NodeJS.ProcessEnv, clock, maxSteps: 4 });
  const firedUnderFreeze = epFrozen.executedActions.length;
  console.log(`\n  KILL-SWITCH (TOFFOLI_EXECUTE_DISABLED=1): actions executed = ${firedUnderFreeze}; sandbox unchanged = ${JSON.stringify(frozen.world.snapshot()) === before}  (the chosen step is gated by the same chokepoint)`);
  console.log(`  ${"=".repeat(98)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
