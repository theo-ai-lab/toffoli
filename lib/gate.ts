/**
 * Toffoli — the recovery-soundness gate. `npm run gate` (used by CI).
 *
 * A deploy gate that fails the build if recovery soundness regresses. The MECHANISM (fail CI on a
 * threshold) is a standard eval-in-CI pattern; the value here is that the thing it gates is
 * *recovery/restitution soundness* — Toffoli's own honest invariants:
 *   - zero catastrophic misclassifications (an irreversible action called auto-undoable),
 *   - zero committed missed-escalations,
 *   - IRREVERSIBLE recall at or above a floor,
 *   - the executor restores the recoverable subset and leaves the irreversible dimensions untouched.
 * Exits non-zero on any failure. Threshold overridable via TOFFOLI_MIN_RECALL.
 */

import { loadGoldSet } from "../dataset/schema";
import { evaluate } from "./engine/metrics";
import { recoveryScenario, buildRecoveryCase } from "./exec/recover";
import { safeExecute, computeConfirmToken } from "./runtime/safe-executor";
import { SANDBOX_AUTO_POLICY } from "./runtime/policy";
import { effectiveMode, KILL_SWITCH_ENV } from "./runtime/mode";

const MIN_RECALL = Number(process.env["TOFFOLI_MIN_RECALL"] ?? "0.70");
// A precision floor makes the recall headline UNGAMEABLE by over-escalation: classifying everything
// IRREVERSIBLE would drive recall→1 but craters precision (every recoverable action becomes a false
// positive), so this check fails. Enforced, not narrated.
const MIN_PRECISION = Number(process.env["TOFFOLI_MIN_PRECISION"] ?? "0.80");

const report = evaluate(loadGoldSet({ includeIncidents: true }));
const irr = report.perClass.find((m) => m.cls === "IRREVERSIBLE");
const recall = irr?.recall ?? 0;
const precision = irr?.precision ?? 0;
const rec = recoveryScenario();

// ── deploy-critical runtime-safety invariants (the unattended-service floor) ──
// 1. The kill-switch is ENFORCED at the chokepoint (forces dry-run regardless of requested mode).
const killEnforced = effectiveMode("execute", { [KILL_SWITCH_ENV]: "1" } as NodeJS.ProcessEnv).effective === "dry-run";
// 2. Plan-only by default mutates nothing.
const planCase = buildRecoveryCase();
const before = planCase.world.snapshot();
safeExecute(planCase.plan, planCase.world, { env: {} as NodeJS.ProcessEnv });
const planOnlyInert = JSON.stringify(planCase.world.snapshot()) === JSON.stringify(before);
// 3. The safe path restores parity AND every reported restoration is journal-confirmed (anti-fabrication).
const execCase = buildRecoveryCase();
const token = computeConfirmToken(execCase.plan);
const safe = safeExecute(execCase.plan, execCase.world, { env: {} as NodeJS.ProcessEnv, confirmToken: token, policy: SANDBOX_AUTO_POLICY });
const safeParity = safe.restored === execCase.plan.steps.length;

const checks = [
  { name: "no catastrophic misclassifications (irreversible called auto-undoable)", pass: report.dangerousMisses === 0, detail: `dangerousMisses=${report.dangerousMisses}` },
  { name: "no committed missed-escalations", pass: report.missedEscalations === 0, detail: `missedEscalations=${report.missedEscalations}` },
  { name: `IRREVERSIBLE recall ≥ ${MIN_RECALL}`, pass: recall >= MIN_RECALL, detail: `recall=${recall.toFixed(2)}` },
  { name: `IRREVERSIBLE precision ≥ ${MIN_PRECISION} (over-escalation can't game recall)`, pass: precision >= MIN_PRECISION, detail: `precision=${precision.toFixed(2)}` },
  { name: "executor restored the recoverable subset to baseline", pass: rec.recoverableRestored, detail: `restored=${rec.result.restored}/${rec.totals.recoverable}` },
  { name: "executor left the irreversible dimensions untouched", pass: rec.irreversibleUntouched, detail: "restraint" },
  { name: "kill-switch ENFORCED at the chokepoint (forces dry-run)", pass: killEnforced, detail: `${KILL_SWITCH_ENV}=1 → dry-run` },
  { name: "plan-only by default mutates nothing", pass: planOnlyInert, detail: "no token, no autoConfirm → zero mutation" },
  { name: "safe path restores parity with the bare executor", pass: safeParity, detail: `restored=${safe.restored}/${execCase.plan.steps.length}` },
  { name: "anti-fabrication: every reported restoration is journal-confirmed", pass: safe.fabricationCheck.pass, detail: safe.fabricationCheck.detail },
];

console.log(`\n  TOFFOLI — recovery-soundness gate\n  ${"─".repeat(62)}`);
let failed = 0;
for (const c of checks) {
  console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  if (!c.pass) failed++;
}
console.log(`  ${"─".repeat(62)}`);
if (failed) {
  console.log(`  GATE FAILED — ${failed} check(s) failed; blocking the build.\n`);
  process.exit(1);
}
console.log("  GATE PASSED — recovery soundness holds.\n");
