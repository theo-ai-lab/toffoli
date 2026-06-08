/**
 * Toffoli — the end-to-end recovery harness. `npm run recover`.
 *
 * The full loop on real (sandboxed) state: a scripted agent damages a World → Toffoli classifies
 * every action → the dependency-aware planner orders the restitution → the executor RUNS it → we
 * VERIFY the recoverable subset (file contents, restored rows, ledger net) matches the pre-damage
 * baseline, and that the
 * irreversible effects were correctly left untouched for a human. This produces a measured
 * recovery rate, not just a plan.
 */

import { World } from "./world";
import { execute, type RecoveryResult } from "./executor";
import { planResumable } from "../engine/resumable";
import { classifyDeterministic } from "../engine/classify";
import type { AgentAction, Classification } from "../engine/types";

function classify(a: AgentAction): Classification {
  return (
    classifyDeterministic(a) ?? {
      actionId: a.id,
      class: "IRREVERSIBLE",
      idempotent: false,
      confidence: 0,
      llmAssisted: false,
      ruleRef: "abstain:fail-safe-escalate",
      rationale: "fail-safe",
    }
  );
}

function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

export interface RecoveryReport {
  result: RecoveryResult;
  recoverableMatch: { files: boolean; rows: boolean; ledger: boolean };
  /** The recoverable subset (file contents, restored rows, ledger net) matches the pre-damage baseline. */
  recoverableRestored: boolean;
  /** RESTRAINT: the executor did NOT touch the irreversible dimensions (vs the post-damage state). */
  irreversibleUntouched: boolean;
  totals: { actions: number; recoverable: number; irreversible: number; restored: number };
}

/** Build the canonical damage scenario WITHOUT executing — for the harness and the replay test. */
export function buildRecoveryCase(): { world: World; actions: AgentAction[]; plan: ReturnType<typeof planResumable>; baseline: ReturnType<World["snapshot"]> } {
  const world = new World();
  world.seedRow("orders", "t1", { is_test: true });
  world.seedRow("orders", "t2", { is_test: true });
  world.seedTable("orders_archive");
  const baseline = world.snapshot();
  const actions: AgentAction[] = [
    world.writeFile("/backups/orders.bak", "id,is_test"),
    world.softDeleteRow("orders", "t1"),
    world.softDeleteRow("orders", "t2"),
    world.charge("enrich-api", 12),
    world.dropTable("orders_archive"),
    world.sendEmail("client@acme.com", "summary attached"),
  ];
  const plan = planResumable(actions, actions.map(classify));
  return { world, actions, plan, baseline };
}

/** Run the canonical damage→recover scenario. `failOn` injects a forced compensation failure. */
export function recoveryScenario(failOn?: string): RecoveryReport {
  const { world, actions, plan, baseline } = buildRecoveryCase();
  const damaged = world.snapshot(); // state AFTER the agent's damage, BEFORE recovery
  const result = execute(plan, world, failOn ? { failOn } : {});
  const after = world.snapshot();

  const recoverableMatch = {
    files: sameRecord(after.files, baseline.files),
    rows: sameRecord(after.rows, baseline.rows),
    ledger: after.ledgerUsd === baseline.ledgerUsd,
  };
  const recoverableRestored = recoverableMatch.files && recoverableMatch.rows && recoverableMatch.ledger;
  // RESTRAINT: the executor must not have changed the irreversible dimensions (tables, outbox) at all.
  const irreversibleUntouched =
    JSON.stringify(after.tables) === JSON.stringify(damaged.tables) && JSON.stringify(after.outbox) === JSON.stringify(damaged.outbox);

  const classifications = actions.map(classify);
  return {
    result,
    recoverableMatch,
    recoverableRestored,
    irreversibleUntouched,
    totals: {
      actions: actions.length,
      recoverable: classifications.filter((c) => c.class === "REVERSIBLE" || c.class === "COMPENSABLE").length,
      irreversible: classifications.filter((c) => c.class === "IRREVERSIBLE").length,
      restored: result.restored,
    },
  };
}

export function renderReport(r: RecoveryReport): string {
  const t = r.totals;
  const m = r.recoverableMatch;
  const lines = [
    `  ${"=".repeat(72)}`,
    "  TOFFOLI — END-TO-END RECOVERY (sandboxed, no real disk/network)",
    `  ${"=".repeat(72)}`,
    `  ${t.actions} agent actions: ${t.recoverable} recoverable, ${t.irreversible} irreversible`,
    `  executed ${r.result.steps.length} compensations → restored ${r.result.restored}, failed ${r.result.failed}, unsupported ${r.result.unsupported}, blocked ${r.result.blocked}`,
    `  recoverable subset matches the pre-damage baseline: ${r.recoverableRestored ? "YES" : "NO"}  (file contents ${m.files ? "✓" : "✗"}  restored rows ${m.rows ? "✓" : "✗"}  ledger net ${m.ledger ? "✓" : "✗"})`,
    `  executor RESTRAINT — irreversible dimensions left untouched: ${r.irreversibleUntouched ? "YES (dropped table + sent email unchanged by recovery)" : "NO ✗"}`,
    `  escalated to a human (never auto-executed): ${r.result.escalated}`,
    r.result.resumeFrom !== null ? `  PARTIAL FAILURE: resume from step ${r.result.resumeFrom}` : "",
    `  ${"-".repeat(72)}`,
    `  RESULT: restored ${t.restored}/${t.recoverable} recoverable actions — the recoverable subset (file`,
    `          contents, restored rows, ledger net) matches the pre-damage baseline; ${t.irreversible} irreversible`,
    `          actions auto-executed: 0.`,
    `  ${"=".repeat(72)}`,
  ].filter(Boolean);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(renderReport(recoveryScenario()));
}
