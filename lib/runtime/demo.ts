/**
 * Toffoli — the safe-runtime demo. `npm run safe`.
 *
 * Runs the canonical damage scenario through the deployed-service execution path three ways, so the
 * operational-safety floor is visible end-to-end:
 *   1. DEFAULT (plan-only)        — emits a signed plan + escalations, mutates NOTHING.
 *   2. KILL-SWITCH                — even with a valid confirm token, forced to dry-run.
 *   3. CONFIRM-TOKEN (execute)    — a human approved the plan → restitution runs, with a WAL journal,
 *                                   bounded retries, circuit breakers, and a passing anti-fabrication check.
 */

import { buildRecoveryCase } from "../exec/recover";
import { safeExecute, computeConfirmToken } from "./safe-executor";
import { SANDBOX_AUTO_POLICY } from "./policy";
import { InMemorySink } from "./escalation";
import { KILL_SWITCH_ENV } from "./mode";
import type { RuntimeReport } from "./safe-executor";

const clock = () => "2026-06-06T00:00:00Z";
const runbookUrl = "https://github.com/<you>/toffoli#operations"; // illustrative: where an operator runbook link would go

function render(title: string, r: RuntimeReport, sink: InMemorySink): string {
  const lines = [
    `  ${"=".repeat(74)}`,
    `  ${title}`,
    `  ${"=".repeat(74)}`,
    `  mode: requested=${r.mode.requested} → effective=${r.mode.effective}${r.mode.killSwitchEngaged ? "  (KILL-SWITCH ENGAGED)" : ""}`,
    `  phase: ${r.phase.toUpperCase()}`,
    "  steps:",
    ...r.steps.map((s) => `    [${s.index}] ${s.method.padEnd(8)} ${s.forActionId.padEnd(10)} → ${s.status}${s.status === "restored" ? `  (journal-confirmed=${s.journalConfirmed})` : ""}  ${s.detail}`),
    `  restored: ${r.restored}   compensation-failed: ${r.compensationFailed}   blocked: ${r.blocked}   unsupported: ${r.unsupported}`,
    `  escalations (durable, → a human): ${r.escalated}`,
    ...sink.records.map((e) => `    ⚠ [${e.severity}] ${e.kind} · ${e.forActionId} · ${e.decision}`),
    `  anti-fabrication check: ${r.fabricationCheck.pass ? "PASS" : "FAIL"} — ${r.fabricationCheck.detail}`,
    `  confirm token for this plan: ${r.confirmToken}`,
  ];
  return lines.join("\n");
}

// 1 — default: plan-only
{
  const { world, plan } = buildRecoveryCase();
  const sink = new InMemorySink();
  const r = safeExecute(plan, world, { clock, env: {} as NodeJS.ProcessEnv, sink, runbookUrl });
  console.log(render("1 · DEFAULT (plan-only — mutates nothing, still escalates the irreversible remainder)", r, sink));
  console.log();
}

// 2 — kill-switch forces dry-run even with a valid token
{
  const { world, plan } = buildRecoveryCase();
  const sink = new InMemorySink();
  const token = computeConfirmToken(plan);
  const r = safeExecute(plan, world, { clock, env: { [KILL_SWITCH_ENV]: "1" } as NodeJS.ProcessEnv, sink, confirmToken: token, policy: SANDBOX_AUTO_POLICY, runbookUrl });
  console.log(render("2 · KILL-SWITCH (TOFFOLI_EXECUTE_DISABLED=1 — valid token ignored, forced dry-run)", r, sink));
  console.log();
}

// 3 — confirm-token authorizes execution
{
  const { world, plan, baseline } = buildRecoveryCase();
  const sink = new InMemorySink();
  const token = computeConfirmToken(plan);
  const r = safeExecute(plan, world, { clock, env: {} as NodeJS.ProcessEnv, sink, confirmToken: token, policy: SANDBOX_AUTO_POLICY, runbookUrl });
  const after = world.snapshot();
  // order-insensitive record compare (rows are restored in reverse order — same set, different insertion order)
  const norm = (o: Record<string, unknown>): string => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));
  const parity = norm(after.files) === norm(baseline.files) && norm(after.rows) === norm(baseline.rows) && after.ledgerUsd === baseline.ledgerUsd;
  console.log(render("3 · CONFIRM-TOKEN (human approved → restitution runs, journaled, bounded, attested)", r, sink));
  console.log(`\n  recoverable subset matches the pre-damage baseline: ${parity ? "YES" : "NO"}`);
  console.log(`  ${"=".repeat(74)}`);
}
