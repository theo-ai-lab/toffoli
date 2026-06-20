/**
 * Toffoli — the self-healing agent loop: public surface + runnable demo. `npm run agent`.
 *
 * The full loop on real (sandboxed) state: a tool-using agent attempts a reconcile-rows task, takes
 * an injected fault (an over-broad bulk delete plus an irreversible send), and Toffoli AUTONOMOUSLY
 * recovers — classifying the genuine run, planning the resumable restitution, and running it through
 * the safe executor to restore the recoverable subset while escalating ONLY the irreversible
 * remainder to a human. The agent then self-corrects and finishes. The headline is a TASK-SUCCESS /
 * recovery metric, not a wall of logs.
 *
 * Deterministic and offline by default (a scripted stub model). Swap in `claudeAgentModel()` for a
 * live run when `ANTHROPIC_API_KEY` is set.
 */

export * from "./tools";
export * from "./loop";
export * from "./memory";
export * from "./scenario";

import type { AgentEvent } from "./loop";
import { RecoveryMemory } from "./memory";
import { runReconcileScenario, type ScenarioResult } from "./scenario";

/** Pretty-print one loop event as it happens (used by the demo, not the library path). */
function printEvent(e: AgentEvent): void {
  switch (e.kind) {
    case "model-text":
      console.log(`  · agent: ${e.detail}`);
      break;
    case "tool-call":
      console.log(`  → tool:  ${e.detail}`);
      break;
    case "tool-result":
      console.log(`  ← result: ${indent(e.detail)}`);
      break;
    case "recovery":
      console.log(`  ⟲ ${indent(e.detail)}`);
      break;
    case "finish":
      console.log(`  ■ ${e.detail}`);
      break;
  }
}

function indent(s: string): string {
  return s.split("\n").join("\n            ");
}

/** Render the task-success headline + the supporting recovery numbers. */
export function renderScenario(s: ScenarioResult): string {
  const r = s.run;
  const rec = r.recoveries[0];
  const lines = [
    `  ${"=".repeat(74)}`,
    "  TOFFOLI — SELF-HEALING AGENT LOOP (sandboxed; no real disk/network)",
    `  ${"=".repeat(74)}`,
    `  goal: reconcile the 'orders' table — remove ONLY the test rows`,
    `  agent run: ${r.turns} turn(s), ${r.actions.length} genuine action(s) performed, finished=${r.finished}`,
    `  injected fault: an over-broad bulk delete hit live rows; the summary email was already sent`,
    `  ${"-".repeat(74)}`,
    rec
      ? `  auto-recovery (triggered by ${rec.trigger}): restored ${rec.restored} recoverable action(s); ` +
        `escalated ${rec.escalations.length} irreversible to a human; anti-fabrication ${rec.report.fabricationCheck.pass ? "PASS" : "FAIL"}`
      : "  auto-recovery: none triggered",
    ...r.escalations.map((e) => `    ⚠ [${e.severity}] ${e.forActionId}: ${e.decision}`),
    `  ${"-".repeat(74)}`,
    `  cross-run memory: ${r.memory.repeatFaultsHandled} repeat fault(s) recovered from memory; ` +
      `${r.memory.classificationsAvoided} re-plan step(s) avoided` +
      (r.memory.firstFaultLatencyMs != null && r.memory.repeatFaultLatencyMs != null
        ? ` (identical fault: ${r.memory.firstFaultLatencyMs.toFixed(2)}ms cold → ${r.memory.repeatFaultLatencyMs.toFixed(2)}ms from memory)`
        : ""),
    `  ${"-".repeat(74)}`,
    `  goal end-state verified: ${s.goalAchieved ? "YES (test rows gone · live rows intact · ledger net == baseline)" : "NO ✗"}`,
    `  recoverable damage reverted: ${s.recoverableReverted ? "YES" : "NO ✗"}   (irreversible auto-undone: 0)`,
    `  ${"=".repeat(74)}`,
    `  TASK-SUCCESS: ${s.taskSuccess ? "YES" : "NO"} — the agent hit a fault, Toffoli auto-reverted ` +
      `${s.restoredCount} recoverable action(s) to baseline and`,
    `                escalated ${s.escalatedCount} irreversible to a human; the goal was then completed correctly.`,
    `  ${"=".repeat(74)}`,
  ];
  return lines.join("\n");
}

/** The runnable demo: drive the scenario, stream events, and print the task-success headline. */
export async function main(): Promise<ScenarioResult> {
  // Deterministic clock so escalation records are reproducible across runs.
  const clock = () => "2026-06-14T00:00:00Z";

  // A persistent memory shared by BOTH runs — this is what makes the learning CROSS-run.
  const memory = new RecoveryMemory(":memory:", { clock });
  try {
    // RUN 1 (cold): first time Toffoli sees this fault — it plans the recovery from scratch.
    const cold = await runReconcileScenario({ onEvent: printEvent, clock, memory });
    console.log(`\n${renderScenario(cold)}`);

    // RUN 2 (warm): a brand-new world, SAME class of fault. Memory recalls the known-good strategy,
    // so the recovery is taken directly — no re-planning. Events muted; we only want the metric.
    const warm = await runReconcileScenario({ clock, memory });
    console.log(`\n${renderCrossRun(cold, warm)}`);

    if (!cold.taskSuccess || !warm.taskSuccess) process.exitCode = 1;
    return cold;
  } finally {
    memory.close();
  }
}

/** A compact second-run headline: the same fault, now recovered from memory without re-planning. */
function renderCrossRun(cold: ScenarioResult, warm: ScenarioResult): string {
  const m = warm.run.memory;
  // Compare the two runs' single recovery of the SAME fault: re-planned (cold) vs recalled (warm).
  // Re-plan steps avoided is the deterministic headline; latency is indicative (offline it is tiny).
  const coldMs = cold.run.recoveries[0]?.latencyMs;
  const warmMs = warm.run.recoveries[0]?.latencyMs;
  const speed = coldMs != null && warmMs != null ? `${coldMs.toFixed(2)}ms cold → ${warmMs.toFixed(2)}ms from memory` : "n/a";
  return [
    `  ${"=".repeat(74)}`,
    "  CROSS-RUN MEMORY — same fault, second run (fresh world, shared memory)",
    `  ${"=".repeat(74)}`,
    `  repeat fault(s) recovered from memory: ${m.repeatFaultsHandled}   (re-plan steps avoided: ${m.classificationsAvoided})`,
    `  task still succeeds via the recalled strategy: ${warm.taskSuccess ? "YES" : "NO ✗"}`,
    `  latency, identical fault: ${speed}`,
    `  ${"=".repeat(74)}`,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
