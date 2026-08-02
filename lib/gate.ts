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

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGoldSet } from "../dataset/schema";
import { evaluate } from "./engine/metrics";
import { classifyDeterministic } from "./engine/classify";
import type { AgentAction, Classification, CompensatingAction } from "./engine/types";
import { lakeOnPath, leanMissingHint } from "./lean-toolchain";
import { recoveryScenario, buildRecoveryCase } from "./exec/recover";
import { fsRecoveryScenario } from "./exec/fs-recover";
import { FsWorld } from "./exec/fs-world";
import { safeExecute, computeConfirmToken } from "./runtime/safe-executor";
import { InMemoryJournal } from "./runtime/journal";
import { DEFAULT_AUTO_POLICY, SANDBOX_AUTO_POLICY, decideAuto } from "./runtime/policy";
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

// ── negative controls: prove the DETECTORS fire, not just that today's run is clean ──
// `npm run gate:mutate` is what forced these in. A check that only observes a healthy run passes
// both when the invariant holds and when the mechanism that enforces it has been gutted — three of
// the checks above were exactly that. Each control below breaks one property on purpose and
// requires the floor to notice, so the check cannot quietly become a decoration.

// 4. Anti-fabrication DETECTOR: with a journal that records intent but never records completion, a
//    "restored" step is by definition unconfirmed — the report must SAY SO. If confirms() ever
//    degenerates (to a constant, to ignoring the write-ahead lineage), this is what fails.
class AmnesicJournal extends InMemoryJournal {
  override complete(): void {} // the durable write is lost — the Replit failure mode, staged
}
const fabCase = buildRecoveryCase();
const fabReport = safeExecute(fabCase.plan, fabCase.world, {
  env: {} as NodeJS.ProcessEnv,
  confirmToken: computeConfirmToken(fabCase.plan),
  policy: SANDBOX_AUTO_POLICY,
  journal: new AmnesicJournal(),
});
const fabricationDetected = fabReport.restored > 0 && !fabReport.fabricationCheck.pass;

// 4b. REAL-WORLD TRUTH. Every check above this line asks the EXECUTOR about itself: `restored` is
//     its own count, and `fabricationCheck` compares that count against the journal the same
//     executor wrote. One witness, asked twice. An executor whose action ids or idempotency keys
//     are wrong reports a restoration, records it, and never moves the disk — which is precisely
//     what 8897b1f fixed in FsWorld. This gate could not have caught it: it ran the in-memory
//     world only, so the real adapters were outside the thing that decides whether this ships.
const fsReal = fsRecoveryScenario();

// 4c. DETECTOR for 4b: a world that returns success from every compensating method and touches
//     nothing. The executor's account is spotless and its journal agrees; only the before/after
//     comparison of the actual filesystem and database dissents. If the world comparison ever
//     degenerates into another reading of the executor's own report, this is what fails.
class LyingFsWorld extends FsWorld {
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
const lyingRoot = mkdtempSync(join(os.tmpdir(), "toffoli-gate-lying-"));
let worldTruthDetects = false;
let worldTruthDetail = "";
try {
  const lying = fsRecoveryScenario({ root: lyingRoot, makeWorld: (r) => new LyingFsWorld(r) });
  worldTruthDetects = lying.result.restored > 0 && lying.result.fabricationCheck.pass && !lying.recoverableRestored;
  worldTruthDetail = worldTruthDetects
    ? `${lying.result.restored} restoration(s) reported and journal-confirmed; the disk says otherwise`
    : `a world that changed nothing was accepted (restored=${lying.result.restored}, fabricationPass=${lying.result.fabricationCheck.pass}, worldRestored=${lying.recoverableRestored})`;
} finally {
  rmSync(lyingRoot, { recursive: true, force: true });
}

// 5. The confirm token is BOUND TO THE PLAN: a token computed for a different plan with the same
//    step COUNT must not authorize this one. (Same count is the point — a token that only hashed
//    the shape would pass a differently-sized-plan test.)
const staleCase = buildRecoveryCase();
const foreignPlan = { ...staleCase.plan, steps: staleCase.plan.steps.map((s) => ({ ...s, forActionId: `${s.forActionId}#foreign` })) };
const beforeStale = JSON.stringify(staleCase.world.snapshot());
const staleReport = safeExecute(staleCase.plan, staleCase.world, {
  env: {} as NodeJS.ProcessEnv,
  confirmToken: computeConfirmToken(foreignPlan),
  policy: SANDBOX_AUTO_POLICY,
});
const staleTokenRefused = staleReport.phase === "plan-only" && JSON.stringify(staleCase.world.snapshot()) === beforeStale;

// 6. The judge may LOWER autonomy, never grant it. The probe is deliberately auto-eligible on every
//    other axis (REVERSIBLE · confidence 1.0 · allow-listed method), so the paired assertion pins the
//    refusal on `llmAssisted` alone rather than on some unrelated guard.
const autoProbe: Classification = { actionId: "gate-probe", class: "REVERSIBLE", idempotent: true, confidence: 1, llmAssisted: false, ruleRef: "gate:probe", rationale: "probe" };
const autoComp: CompensatingAction = { forActionId: "gate-probe", method: "restore", idempotencyKey: "gate:probe", restoration: "exact", rationale: "probe" };
const judgeCannotGrantAutonomy =
  decideAuto({ ...autoProbe, llmAssisted: true }, autoComp, DEFAULT_AUTO_POLICY).auto === false && decideAuto(autoProbe, autoComp, DEFAULT_AUTO_POLICY).auto === true;

// 7. The fail-toward-severe rules still COMMIT. The recall floor is a floor: falsification showed a
//    load-bearing rule can be deleted and recall still clears it (0.83 → 0.71 against a 0.70 bar).
//    So name the catastrophic cases directly — each must classify IRREVERSIBLE deterministically,
//    never abstain, never soften.
const severeProbes: Array<[string, AgentAction]> = [
  ["hard delete, no recoverable copy", { id: "s1", tool: "db.delete", op: "delete", target: { kind: "db.row", id: "1" } }],
  ["DROP TABLE, no backup", { id: "s2", tool: "sql.execute", op: "execute", params: { sql: "DROP TABLE orders" }, target: { kind: "db.table", id: "orders" } }],
  ["email delivered externally", { id: "s3", tool: "email.send", op: "send", target: { kind: "email", externalized: true } }],
  ["payment settled out of your control", { id: "s4", tool: "stripe.charge", op: "pay", target: { kind: "payment", externalized: true } }],
];
const severeMissed = severeProbes.filter(([, a]) => classifyDeterministic(a)?.class !== "IRREVERSIBLE").map(([label]) => label);

// ── mechanized-proof gate (additive) ──────────────────────────────────────────
// The Lean soundness model (formal/) must kernel-check, AND must remain a faithful
// abstraction of the real classifier (formal/diff_check.ts pins classifyPlus to
// classifyDeterministic over the full Signals space). Both run as `proof:check`
// equivalents here so a regression in either blocks the build. `elan` is added to
// PATH; the running node binary's dir is added so the diff sub-process can spawn tsx.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const formalDir = resolve(repoRoot, "formal");
const proofEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${os.homedir()}/.elan/bin:${dirname(process.execPath)}:${process.env["PATH"] ?? ""}`,
};

let proofKernelOk = false;
let proofKernelDetail = "";
try {
  execSync("lake build", { cwd: formalDir, env: proofEnv, stdio: "pipe" });
  proofKernelOk = true;
  proofKernelDetail = "lake build (formal/) — soundness + corollary kernel-check, no sorry";
} catch (e) {
  // Distinguish "no Lean toolchain installed" (actionable: install elan) from "the proof failed to
  // kernel-check" (a real regression) — a missing `lake` otherwise reads as an opaque exec failure.
  proofKernelDetail = lakeOnPath(proofEnv) ? `lake build failed: ${String((e as Error).message).split("\n")[0]}` : leanMissingHint();
}

let proofFaithfulOk = false;
let proofFaithfulDetail = "";
try {
  execSync("node_modules/.bin/tsx formal/diff_check.ts", {
    cwd: repoRoot,
    env: proofEnv,
    stdio: "pipe",
  });
  proofFaithfulOk = true;
  proofFaithfulDetail = "classifyDeterministic (abstain↦⊤) == verified classifyPlus on all signals";
} catch (e) {
  proofFaithfulOk = false;
  // diff_check drives `lake exe export_table` too, so a missing toolchain surfaces here as well.
  proofFaithfulDetail = lakeOnPath(proofEnv) ? `diff_check failed: ${String((e as Error).message).split("\n")[0]}` : leanMissingHint();
}

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
  { name: "the REAL on-disk world returns to baseline (not the executor's account of itself)", pass: fsReal.recoverableRestored, detail: `files=${fsReal.recoverableMatch.files} rows=${fsReal.recoverableMatch.rows} ledger=${fsReal.recoverableMatch.ledger}` },
  { name: "a fresh world over the same on-disk root replays with zero extra mutation", pass: fsReal.idempotentOnReplay, detail: "durable idempotency" },
  { name: "WORLD-TRUTH DETECTOR fires when a compensation is reported but never applied", pass: worldTruthDetects, detail: worldTruthDetail },
  { name: "anti-fabrication DETECTOR fires on a lost durable write", pass: fabricationDetected, detail: fabricationDetected ? `${fabReport.restored} restoration(s) reported, all flagged unconfirmed` : "a journal that never completed a step still reported PASS" },
  { name: "a confirm token bound to a DIFFERENT plan is refused", pass: staleTokenRefused, detail: staleTokenRefused ? `phase=${staleReport.phase}; world unchanged` : `phase=${staleReport.phase}; a foreign token authorized this plan` },
  { name: "the judge can lower autonomy, never grant it", pass: judgeCannotGrantAutonomy, detail: judgeCannotGrantAutonomy ? "llmAssisted verdict blocked; the same verdict un-judged is auto-eligible" : "an llmAssisted verdict earned auto-execution" },
  { name: "the fail-toward-severe rules still commit (no silent abstention)", pass: severeMissed.length === 0, detail: severeMissed.length === 0 ? `${severeProbes.length}/${severeProbes.length} catastrophic cases classified IRREVERSIBLE` : `not IRREVERSIBLE: ${severeMissed.join("; ")}` },
  { name: "Lean soundness proof kernel-checks (no under-call + catastrophic safety)", pass: proofKernelOk, detail: proofKernelDetail },
  { name: "Lean model is faithful to the TS classifier bytes (diff_check)", pass: proofFaithfulOk, detail: proofFaithfulDetail },
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
