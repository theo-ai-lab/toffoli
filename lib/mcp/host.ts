/**
 * Toffoli — an MCP agent HOST: a real client that drives the Toffoli MCP server over stdio.
 * `npm run host`.
 *
 * This is the genuine consumer of lib/mcp/server.ts. It spawns the server as a child process
 * (through the repo's own `tsx`, exactly as `npm run mcp` does), connects to it with the
 * `ToffoliMcpClient` over stdin/stdout, and runs a REAL agent task through the full
 * checkpoint → classify → recover lifecycle — a true cross-process client → server round trip.
 *
 * ── WHY THE RECOVERY IS REAL (a shared backend, not a mock) ──
 * The host and the server both point at ONE on-disk `FsWorld` root (the server via
 * TOFFOLI_MCP_FS_ROOT). That mirrors a real deployment: Toffoli's recovery world IS the live system
 * the agent operates on. So when the host's tools damage the world and the server's `recover`
 * compensates it, they are reading and writing the SAME files — the restoration is observable on
 * disk from both sides, not simulated.
 *
 * ── THE TASK (the canonical injected fault) ──
 *   GOAL: reconcile an `orders` table for month-end close — remove only the test/sandbox rows.
 *   1. checkpoint the live system before touching it (read-only snapshot via the server).
 *   2. The agent's first cleanup pass is OVER-BROAD: it soft-deletes EVERY order (3 live + 2 test),
 *      charges an enrichment fee, and emails finance — three deletes hit live data, the email leaves.
 *   3. classify each genuine action through the server (deterministic rules; the judge is gated off).
 *   4. recover (plan-only first) returns a plan + a plan-bound confirm token, mutating nothing.
 *   5. recover (execute, re-presenting that token) restores the recoverable subset on disk — all
 *      soft-deleted rows + the refund — and escalates the irreversible email to a human.
 *   6. The agent, told it was recovered, retries the cleanup correctly (only the two test rows) and
 *      the goal end-state is verified against the checkpoint.
 *
 * Deterministic and offline: the agent's turns are scripted (no model call) and every classify/recover
 * forces the deterministic rules (no API key needed). `TOFFOLI_EXECUTE_DISABLED=1 npm run host` makes
 * the server force dry-run at step 5 — the host reports the kill-switch honestly and claims no recovery.
 *
 * Zero runtime dependencies beyond the engine + the FsWorld adapter + the MCP client.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAction } from "../engine/types";
import { FsWorld } from "../exec/fs-world";
import { LIVE_IDS, SEED_ORDERS, TEST_IDS } from "../agent/scenario";
import { spawnToffoliServer, ToffoliMcpClient } from "./client";

const ENRICH_FEE_USD = 9;
const SUMMARY_RECIPIENT = "finance@corp.test";

export interface HostClassification {
  actionId: string;
  tool: string;
  class: string;
  recoverable: boolean;
  requiresHuman: boolean;
  judged: boolean;
}

export interface HostRunResult {
  /** The temp root the shared FsWorld lives under (removed unless `keep` was set). */
  root: string;
  serverName: string;
  /** The tool names the server advertised over tools/list. */
  toolNames: string[];
  checkpointId: string;
  /** Rows the server saw in the pre-damage checkpoint snapshot. */
  baselineRows: number;
  /** Per-action verdicts, served by the server's toffoli.classify. */
  classifications: HostClassification[];
  /** The plan-only recover: a plan + confirm token, with nothing mutated. */
  planOnly: { phase: string; confirmToken: string; plannedSteps: number; escalations: number };
  /** The authorized execute recover (or a kill-switch-forced dry-run). */
  executed: {
    phase: string;
    effectiveMode: string;
    killSwitchEngaged: boolean;
    restored: number;
    escalated: number;
    fabricationPass: boolean;
    recoverableMatchesCheckpoint: boolean;
  };
  /** Final on-disk verdicts after the corrected retry. */
  final: { liveRowsPresent: boolean; testRowsGone: boolean; ledgerNetZero: boolean; emailStillSent: boolean };
  /** THE HEADLINE: the goal was met via genuine, server-driven recovery over the real backend. */
  taskSuccess: boolean;
}

export interface RunHostOptions {
  /** Reuse a specific FsWorld root instead of a fresh temp dir (mainly for tests). */
  root?: string;
  /** Leave the temp dir on disk after the run (default false). */
  keep?: boolean;
  /** Extra env for the spawned server (e.g. `{ TOFFOLI_EXECUTE_DISABLED: "1" }` to test the gate). */
  serverEnv?: NodeJS.ProcessEnv;
  /** Capture the server's stderr instead of inheriting it (quiet; used by tests). */
  quiet?: boolean;
  /** Stream a human-legible line per protocol step (used by the demo). */
  onLog?: (line: string) => void;
}

/**
 * Run the full reconcile task against the live MCP server and compute the task-success verdict.
 * Every step is a genuine JSON-RPC call to the spawned server; the recovery genuinely mutates the
 * shared on-disk world. The function always tears the client down and (unless `keep`) removes the
 * temp dir.
 */
export async function runReconcileHost(opts: RunHostOptions = {}): Promise<HostRunResult> {
  const log = opts.onLog ?? (() => {});
  const createdRoot = opts.root === undefined;
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "toffoli-host-"));

  // The live system the agent operates on — seeded with 3 live + 2 test orders. The server shares
  // this exact directory as its recovery world.
  const world = new FsWorld(root);
  for (const { id, row } of SEED_ORDERS) world.seedRow("orders", id, row);
  world.seedTable("orders_archive");
  const baseline = world.snapshot();

  const transport = spawnToffoliServer({ fsRoot: root, env: opts.serverEnv, stderr: opts.quiet ? "pipe" : "inherit" });
  const client = new ToffoliMcpClient(transport);

  try {
    const info = await client.initialize();
    log(`connected to ${info.serverInfo.name} v${info.serverInfo.version} (protocol ${info.protocolVersion})`);

    const tools = await client.listTools();
    const toolNames = tools.map((t) => t.name);
    log(`tools/list → ${toolNames.join(", ")}`);

    // 1 — checkpoint the live system BEFORE the risky step (read-only).
    const cp = await client.checkpoint({ label: "pre-reconcile" });
    const baselineRows = Object.keys(cp.snapshot.rows).length;
    log(`checkpoint '${cp.checkpointId}' captured ${baselineRows} live row(s) before cleanup`);

    // 2 — the agent's OVER-BROAD cleanup pass, performed against the shared world (the agent's own
    // tools, not Toffoli — Toffoli is the recovery layer). Each mutator returns the genuine action.
    const allIds = SEED_ORDERS.map((o) => o.id);
    const actions: AgentAction[] = [
      ...allIds.map((id) => world.softDeleteRow("orders", id)),
      world.charge("enrich-api", ENRICH_FEE_USD),
      world.sendEmail(SUMMARY_RECIPIENT, "Month-end reconcile complete; summary attached."),
    ];
    log(`agent FAULT: soft-deleted ${allIds.length} order(s) (incl. ${LIVE_IDS.length} live), charged $${ENRICH_FEE_USD}, emailed ${SUMMARY_RECIPIENT}`);

    // 3 — classify each genuine action through the server (deterministic rules only).
    const classifications: HostClassification[] = [];
    for (const action of actions) {
      const c = await client.classify({ action, deterministicOnly: true });
      classifications.push({
        actionId: action.id,
        tool: action.tool,
        class: c.classification.class,
        recoverable: c.recoverable,
        requiresHuman: c.requiresHuman,
        judged: c.judged,
      });
    }
    const needHuman = classifications.filter((c) => c.requiresHuman).length;
    log(`classify → ${classifications.filter((c) => c.recoverable).length} recoverable, ${needHuman} need a human`);

    // 4 — plan-only recover: a full plan + a plan-bound confirm token, mutating nothing.
    const planOnly = await client.recover({ actions, deterministicOnly: true, checkpointId: cp.checkpointId });
    log(`recover (plan-only) → phase=${planOnly.report.phase}, ${planOnly.planSummary.steps} step(s) planned, ${planOnly.planSummary.escalations} escalation(s); token=${planOnly.confirmToken.slice(0, 12)}…`);

    // 5 — execute recover by re-presenting the plan-bound token (a human approved THIS plan). The
    // kill-switch, if engaged in the server's env, forces dry-run here regardless of the token.
    const executed = await client.recover({
      actions,
      deterministicOnly: true,
      checkpointId: cp.checkpointId,
      mode: "execute",
      confirmToken: planOnly.confirmToken,
      policy: "sandbox",
    });
    const mode = executed.report.mode;
    log(
      `recover (execute) → phase=${executed.report.phase}, mode=${mode.effective}${mode.killSwitchEngaged ? " (KILL-SWITCH)" : ""}, ` +
        `restored ${executed.report.restored}, escalated ${executed.report.escalated}, anti-fabrication ${executed.report.fabricationCheck.pass ? "PASS" : "FAIL"}`,
    );

    // 6 — the corrected retry (only meaningful if recovery actually restored the rows): re-delete
    // ONLY the test rows. If the kill-switch forced dry-run, the rows are still trashed — skip it.
    if (executed.executed) {
      for (const id of TEST_IDS) world.softDeleteRow("orders", id);
      log(`agent retry: soft-deleted ONLY the ${TEST_IDS.length} test order(s) — the corrected cleanup`);
    }

    const finalState = world.snapshot();
    const present = new Set(orderIds(finalState));
    const final = {
      liveRowsPresent: LIVE_IDS.every((id) => present.has(id)),
      testRowsGone: TEST_IDS.every((id) => !present.has(id)),
      ledgerNetZero: finalState.ledgerUsd === baseline.ledgerUsd,
      emailStillSent: finalState.outbox.length === 1,
    };

    const recoverableMatchesCheckpoint = executed.checkpoint?.recoverableMatchesCheckpoint ?? false;
    const taskSuccess =
      executed.executed &&
      executed.report.fabricationCheck.pass &&
      recoverableMatchesCheckpoint &&
      final.liveRowsPresent &&
      final.testRowsGone &&
      final.ledgerNetZero &&
      final.emailStillSent;

    return {
      root,
      serverName: info.serverInfo.name,
      toolNames,
      checkpointId: cp.checkpointId,
      baselineRows,
      classifications,
      planOnly: {
        phase: planOnly.report.phase,
        confirmToken: planOnly.confirmToken,
        plannedSteps: planOnly.planSummary.steps,
        escalations: planOnly.planSummary.escalations,
      },
      executed: {
        phase: executed.report.phase,
        effectiveMode: mode.effective,
        killSwitchEngaged: mode.killSwitchEngaged,
        restored: executed.report.restored,
        escalated: executed.report.escalated,
        fabricationPass: executed.report.fabricationCheck.pass,
        recoverableMatchesCheckpoint,
      },
      final,
      taskSuccess,
    };
  } finally {
    client.close();
    if (createdRoot && !opts.keep) rmSync(root, { recursive: true, force: true });
  }
}

/** Bare ids of the live `orders` rows in a snapshot (keys are `orders:<id>`). */
function orderIds(state: { rows: Record<string, unknown> }): string[] {
  const prefix = "orders:";
  return Object.keys(state.rows)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}

/** Render the task-success headline + the supporting per-step numbers. */
export function renderHostRun(r: HostRunResult): string {
  const e = r.executed;
  const lines = [
    `  ${"=".repeat(76)}`,
    "  TOFFOLI — MCP AGENT HOST (a real client driving the server over stdio)",
    `  ${"=".repeat(76)}`,
    `  server: ${r.serverName}   tools: ${r.toolNames.join(", ")}`,
    `  shared FsWorld root (server + host, real disk): ${r.root}`,
    `  ${"-".repeat(76)}`,
    `  checkpoint ${r.checkpointId}: ${r.baselineRows} live row(s) snapshotted before cleanup`,
    `  classify (deterministic): ${r.classifications.map((c) => `${c.tool}=${c.class}`).join(", ")}`,
    `  recover (plan-only): ${r.planOnly.plannedSteps} step(s) planned, ${r.planOnly.escalations} escalation(s), nothing mutated`,
    `                       confirm token bound to this plan: ${r.planOnly.confirmToken}`,
    `  recover (execute):   phase=${e.phase}, mode=${e.effectiveMode}${e.killSwitchEngaged ? " (KILL-SWITCH → dry-run)" : ""}`,
    `                       restored ${e.restored} on disk, escalated ${e.escalated} to a human, anti-fabrication ${e.fabricationPass ? "PASS" : "FAIL"}`,
    `                       recoverable subset matches the checkpoint: ${e.recoverableMatchesCheckpoint ? "YES" : "NO"}`,
    `  ${"-".repeat(76)}`,
    `  goal end-state on disk: live rows present ${tick(r.final.liveRowsPresent)} · test rows gone ${tick(r.final.testRowsGone)} · ` +
      `ledger net == baseline ${tick(r.final.ledgerNetZero)} · email stays sent (escalated) ${tick(r.final.emailStillSent)}`,
    `  ${"=".repeat(76)}`,
    ...closingNarrative(r),
    `  ${"=".repeat(76)}`,
  ];
  return lines.join("\n");
}

/** The honest closing line(s): success only when recovery genuinely ran; the kill-switch is named. */
function closingNarrative(r: HostRunResult): string[] {
  if (r.taskSuccess) {
    return [
      "  TASK-SUCCESS: YES — the agent hit a fault, the MCP server recovered the recoverable",
      "                subset on a real shared backend and escalated the irreversible email; the goal",
      "                was then completed correctly. Every step was a live client → server call.",
    ];
  }
  if (r.executed.killSwitchEngaged) {
    return [
      "  TASK-SUCCESS: NO — the kill-switch (TOFFOLI_EXECUTE_DISABLED) forced the execute recover to",
      "                dry-run: nothing was mutated, the live rows stay deleted, and the host claims NO",
      "                recovery. This is the gate working as designed, reported honestly — not a failure.",
    ];
  }
  return ["  TASK-SUCCESS: NO — recovery did not restore the goal end-state (see the checks above)."];
}

function tick(b: boolean): string {
  return b ? "YES" : "NO ✗";
}

/** The runnable demo: drive the task through the live server, stream events, print the headline. */
export async function main(): Promise<HostRunResult> {
  const result = await runReconcileHost({ onLog: (l) => console.log(`  · ${l}`) });
  console.log(`\n${renderHostRun(result)}`);
  if (!result.taskSuccess && !result.executed.killSwitchEngaged) process.exitCode = 1;
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
