/**
 * Toffoli — the end-to-end recovery loop on the REAL filesystem. `npm run recover:fs`.
 *
 * The same canonical damage→recover scenario as `npm run recover`, but executed against `FsWorld` —
 * actual files, an actual JSON row store with a real trash dir, an actual money-ledger file. It then
 * proves the two properties the in-memory demo can only assert and a *real* system must actually
 * honor:
 *   1. RESTORATION — the recoverable subset on disk matches the pre-damage baseline.
 *   2. RESTRAINT  — the irreversible dimensions (dropped table, sent email) are left untouched.
 *   3. DURABLE IDEMPOTENCY — a fresh `FsWorld` over the SAME root replays the plan as a pure no-op
 *      (the claim journal is persisted to disk), i.e. recovery survives a process restart without
 *      double-applying.
 *
 * Nothing here touches anything outside a throwaway temp directory, which is removed at the end.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsWorld } from "./fs-world";
import { safeExecute, computeConfirmToken, type RuntimeReport } from "../runtime/safe-executor";
import { SANDBOX_AUTO_POLICY } from "../runtime/policy";
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

/** Order-insensitive deep compare of two `{key: value}` records (rows restore in reverse order). */
function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

export interface FsRecoveryReport {
  root: string;
  result: RuntimeReport;
  recoverableMatch: { files: boolean; rows: boolean; ledger: boolean };
  recoverableRestored: boolean;
  irreversibleUntouched: boolean;
  /** Per-dimension result of the SECOND damage->recover cycle over the same root. */
  secondCycleMatch: { files: boolean; rows: boolean; ledger: boolean };
  /** Did a REOPENED world recover a second, different set of damage? (8897b1f's precondition.) */
  secondCycleRestored: boolean;
  /** How many restorations the second cycle REPORTED, regardless of what the disk did. */
  secondCycleReported: number;
  /** A fresh FsWorld over the same root replayed the plan with zero additional mutation. */
  idempotentOnReplay: boolean;
  totals: { actions: number; recoverable: number; irreversible: number; restored: number };
}

/**
 * Run the canonical damage→recover scenario on a real FsWorld, THROUGH the full operational-safety
 * floor (the deploy path) — not the bare saga loop. Pass `keep:true` to leave the temp dir on disk.
 */
/**
 * A world that REPORTS every compensation as a success and changes nothing.
 *
 * The negative control for the gate's world-truth check: its executor account is
 * spotless and its journal agrees, so only a before/after comparison of the real disk
 * can dissent. Defined ONCE and exported, because it was briefly defined twice — in
 * `lib/gate.ts` and in `fs-recover.gate.test.ts` — and a control that exists in two
 * copies drifts. If `FsWorld` gains a compensating method and only one copy overrides
 * it, the two detectors stop agreeing and the GATE is the one that silently weakens.
 */
export class LyingFsWorld extends FsWorld {
  override deleteFile(): boolean {
    return true;
  }
  override restoreRow(): boolean {
    return true;
  }
  override refund(): boolean {
    return true;
  }
}

export function fsRecoveryScenario(
  opts: {
    root?: string;
    keep?: boolean;
    /**
     * Build the world under test. Injected so the gate can run a NEGATIVE CONTROL: a world that
     * reports every compensation as a success and touches nothing. The executor and its journal
     * agree in that case, so only the before/after disk comparison below can tell — which is the
     * whole reason this scenario exists rather than trusting `fabricationCheck`.
     *
     * A factory, not an instance: the replay pass builds a second world over the same root.
     */
    makeWorld?: (root: string) => FsWorld;
  } = {},
): FsRecoveryReport {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "toffoli-fs-"));
  const makeWorld = opts.makeWorld ?? ((r: string) => new FsWorld(r));
  try {
    const world = makeWorld(root);
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
    const classifications = actions.map(classify);
    const plan = planResumable(actions, classifications);

    const damaged = world.snapshot(); // state AFTER the agent's damage, BEFORE recovery
    // Recover the REAL disk through the full safety floor (the unattended-deploy path), not the bare
    // saga loop: the ENFORCED kill-switch, plan-only-by-default, the WAL journal + anti-fabrication
    // invariant, policy, and a plan-bound confirm token authorizing this exact plan. mode:"execute"
    // because FsWorld is a real adapter — and TOFFOLI_EXECUTE_DISABLED=1 forces dry-run here too.
    const token = computeConfirmToken(plan);
    const result = safeExecute(plan, world, { mode: "execute", confirmToken: token, policy: SANDBOX_AUTO_POLICY });
    const after = world.snapshot();

    const recoverableMatch = {
      files: sameRecord(after.files, baseline.files),
      rows: sameRecord(after.rows, baseline.rows),
      ledger: after.ledgerUsd === baseline.ledgerUsd,
    };
    const recoverableRestored = recoverableMatch.files && recoverableMatch.rows && recoverableMatch.ledger;
    const irreversibleUntouched =
      JSON.stringify(after.tables) === JSON.stringify(damaged.tables) && JSON.stringify(after.outbox) === JSON.stringify(damaged.outbox);

    // DURABLE IDEMPOTENCY: a brand-new FsWorld over the same on-disk root replays the plan. Because
    // the claim journal is persisted, every inverse is a skip — no double-refund, no corruption.
    const replayWorld = makeWorld(root);
    safeExecute(plan, replayWorld, { mode: "execute", confirmToken: token, policy: SANDBOX_AUTO_POLICY });
    const afterReplay = replayWorld.snapshot();
    const idempotentOnReplay = JSON.stringify(afterReplay) === JSON.stringify(after);

    // SECOND CYCLE over the SAME on-disk root — the precondition 8897b1f actually needs.
    //
    // Everything above damages once. The replay reuses the SAME plan object with the same
    // action ids, so the id allocator is never called a second time and the defect this
    // scenario was built to catch is structurally invisible: an adversarial review reverted
    // nextId() to the ephemeral counter and the whole gate still passed 19/19 while the unit
    // suite failed 7 of 16. A gate that cannot fail for its own motivating defect is a gate
    // that says less than it sounds like.
    //
    // A reopened world damaging a fresh set of actions is what forces new ids against the
    // durable applied/ markers. With an instance-local counter the second cycle's ids collide
    // with the first's, every compensation short-circuits as already-applied, and the world
    // does NOT return to baseline — while the executor still reports restorations.
    const cycle2World = makeWorld(root);
    const cycle2Baseline = cycle2World.snapshot();
    const cycle2Actions: AgentAction[] = [
      cycle2World.writeFile("/backups/orders-2.bak", "id,is_test"),
      cycle2World.softDeleteRow("orders", "t1"),
      cycle2World.charge("enrich-api", 7),
    ];
    const cycle2Plan = planResumable(cycle2Actions, cycle2Actions.map(classify));
    const cycle2Result = safeExecute(cycle2Plan, cycle2World, {
      mode: "execute",
      confirmToken: computeConfirmToken(cycle2Plan),
      policy: SANDBOX_AUTO_POLICY,
    });
    const afterCycle2 = cycle2World.snapshot();
    const secondCycleMatch = {
      files: sameRecord(afterCycle2.files, cycle2Baseline.files),
      rows: sameRecord(afterCycle2.rows, cycle2Baseline.rows),
      ledger: afterCycle2.ledgerUsd === cycle2Baseline.ledgerUsd,
    };
    const secondCycleRestored =
      secondCycleMatch.files && secondCycleMatch.rows && secondCycleMatch.ledger;

    return {
      root,
      result,
      recoverableMatch,
      recoverableRestored,
      irreversibleUntouched,
      idempotentOnReplay,
      secondCycleMatch,
      secondCycleRestored,
      secondCycleReported: cycle2Result.restored,
      totals: {
        actions: actions.length,
        recoverable: classifications.filter((c) => c.class === "REVERSIBLE" || c.class === "COMPENSABLE").length,
        irreversible: classifications.filter((c) => c.class === "IRREVERSIBLE").length,
        restored: result.restored,
      },
    };
  } finally {
    if (!opts.keep) rmSync(root, { recursive: true, force: true });
  }
}

export function renderFsReport(r: FsRecoveryReport): string {
  const m = r.recoverableMatch;
  return [
    `  ${"=".repeat(74)}`,
    "  TOFFOLI — END-TO-END RECOVERY ON THE REAL FILESYSTEM (FsWorld adapter)",
    `  ${"=".repeat(74)}`,
    `  root: ${r.root}`,
    `  ${r.totals.actions} agent actions: ${r.totals.recoverable} recoverable, ${r.totals.irreversible} irreversible`,
    `  through the safety floor: mode=${r.result.mode.effective}${r.result.mode.killSwitchEngaged ? " (kill-switch ENGAGED → dry-run)" : ""}, anti-fabrication ${r.result.fabricationCheck.pass ? "✓ PASS" : "✗ FAIL"}`,
    `  executed ${r.result.steps.length} compensations → restored ${r.result.restored}, failed ${r.result.compensationFailed}, unsupported ${r.result.unsupported}, blocked ${r.result.blocked}`,
    `  recoverable subset matches pre-damage baseline ON DISK: ${r.recoverableRestored ? "YES" : "NO"}  (files ${m.files ? "✓" : "✗"}  rows ${m.rows ? "✓" : "✗"}  ledger ${m.ledger ? "✓" : "✗"})`,
    `  RESTRAINT — irreversible dimensions left untouched: ${r.irreversibleUntouched ? "YES (dropped table + sent email unchanged)" : "NO ✗"}`,
    `  DURABLE IDEMPOTENCY — a fresh process replays the plan as a no-op: ${r.idempotentOnReplay ? "YES (claim journal persisted; no double-apply)" : "NO ✗"}`,
    `  escalated to a human (never auto-executed): ${r.result.escalated}`,
    `  ${"-".repeat(74)}`,
    `  RESULT: restored ${r.totals.restored}/${r.totals.recoverable} recoverable actions to a byte-identical baseline`,
    `          on REAL disk; ${r.totals.irreversible} irreversible actions auto-executed: 0.`,
    `  ${"=".repeat(74)}`,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(renderFsReport(fsRecoveryScenario()));
}
