import { describe, it, expect } from "vitest";
import {
  runReconcileScenario,
  seedReconcileWorld,
  reconcileToolSet,
  LIVE_IDS,
  TEST_IDS,
} from "./index";
import {
  runAgentLoop,
  scriptedModel,
  assistantTurn,
  sayText,
  toolUse,
  claudeAgentModel,
} from "./loop";

const clock = () => "2026-06-14T00:00:00Z";

describe("self-healing agent loop — fault → recover → finish", () => {
  it("completes the task by auto-recovering an over-broad bulk delete (offline, no API key)", async () => {
    const prev = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"]; // prove the loop drives entirely off the stub model
    try {
      const s = await runReconcileScenario({ clock });

      // THE HEADLINE: task succeeded via genuine recovery, loop ran to completion.
      expect(s.taskSuccess).toBe(true);
      expect(s.run.finished).toBe(true);

      // Goal end-state: live rows present, test rows gone, ledger back to baseline (fee refunded).
      const present = new Set(Object.keys(s.final.rows).map((k) => k.replace(/^orders:/, "")));
      for (const id of LIVE_IDS) expect(present.has(id)).toBe(true);
      for (const id of TEST_IDS) expect(present.has(id)).toBe(false);
      expect(s.final.ledgerUsd).toBe(s.baseline.ledgerUsd);

      // Exactly one recovery pass: 5 rows restored + 1 refund = 6 recoverable; 1 irreversible email escalated.
      expect(s.run.recoveries).toHaveLength(1);
      expect(s.restoredCount).toBe(6);
      expect(s.escalatedCount).toBe(1);
      expect(s.recoverableReverted).toBe(true);
    } finally {
      if (prev !== undefined) process.env["ANTHROPIC_API_KEY"] = prev;
    }
  });

  it("RESTRAINT: the irreversible send is escalated, never auto-undone (outbox keeps the email)", async () => {
    const s = await runReconcileScenario({ clock });
    // The email left the building during the fault and stays sent — recovery must not have emptied it.
    expect(s.final.outbox.length).toBe(1);
    expect(s.run.escalations).toHaveLength(1);
    expect(s.run.escalations[0]!.severity).toBe("high"); // send:external-dispatch
    expect(s.run.escalations[0]!.kind).toBe("irreversible");
    // The recovery report itself never reports a fabricated restoration.
    expect(s.run.recoveries[0]!.report.fabricationCheck.pass).toBe(true);
  });

  it("the recovery is genuinely load-bearing: WITHOUT a corrected retry the goal is NOT met", async () => {
    // A model that makes the over-broad delete and then immediately finishes (no self-correction).
    // Recovery restores the rows to baseline, but the test rows are never re-deleted → goal unmet.
    const world = seedReconcileWorld();
    const tools = reconcileToolSet();
    const naive = scriptedModel([
      assistantTurn(
        sayText("Deleting everything and finishing."),
        toolUse("d1", "delete_rows", { table: "orders", ids: ["1001", "1002", "1003", "1004", "1005"] }),
      ),
      assistantTurn(sayText("done"), toolUse("d2", "finish", { summary: "deleted" })),
    ]);
    const run = await runAgentLoop({
      model: naive,
      world,
      tools,
      goal: "delete the test orders",
      env: {} as NodeJS.ProcessEnv,
      mode: "sandbox",
      clock,
    });
    const present = new Set(Object.keys(world.snapshot().rows).map((k) => k.replace(/^orders:/, "")));
    // Recovery restored ALL five rows to baseline (so live rows survived the fault) ...
    for (const id of LIVE_IDS) expect(present.has(id)).toBe(true);
    // ... but the test rows are back too (never re-deleted) — the goal is NOT achieved without the retry.
    expect([...TEST_IDS].some((id) => present.has(id))).toBe(true);
    expect(run.recoveries).toHaveLength(1);
    expect(run.recoveries[0]!.restored).toBe(5); // 5 rows restored (this naive model charges no fee)
  });

  it("builds the run log from genuine ops only (reads emit no action; mutations do)", async () => {
    const s = await runReconcileScenario({ clock });
    // 5 over-broad soft-deletes + 1 charge + 1 email (fault) + 2 corrected soft-deletes = 9; reads emit nothing.
    expect(s.run.actions).toHaveLength(9);
    expect(s.run.actions.every((a) => a.id && a.tool)).toBe(true);
  });

  it("idempotent recovery: re-running the loop's recovery does not double-refund", async () => {
    // Drive the fault twice in a row before any corrected retry; the second sweep must be a success-skip.
    const world = seedReconcileWorld();
    const tools = reconcileToolSet();
    const allIds = ["1001", "1002", "1003", "1004", "1005"];
    const twice = scriptedModel([
      assistantTurn(toolUse("a1", "delete_rows", { table: "orders", ids: allIds }), toolUse("a2", "charge_fee", { merchant: "x", amountUsd: 9 })),
      assistantTurn(toolUse("b1", "list_rows", { table: "orders" }), toolUse("b2", "charge_fee", { merchant: "x", amountUsd: 9 }), toolUse("b3", "delete_rows", { table: "orders", ids: allIds })),
      assistantTurn(toolUse("c1", "finish", { summary: "done" })),
    ]);
    const run = await runAgentLoop({ model: twice, world, tools, goal: "g", env: {} as NodeJS.ProcessEnv, mode: "sandbox", clock });
    // Two charges of $9 and at least two recovery sweeps; the ledger must net to baseline ($0), not be over-refunded.
    expect(run.recoveries.length).toBeGreaterThanOrEqual(2);
    expect(world.snapshot().ledgerUsd).toBe(0);
  });

  it("the live model adapter is gated: claudeAgentModel rejects with no key, never touching the network", async () => {
    const prev = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      await expect(
        claudeAgentModel()({ system: "s", tools: [], messages: [] }),
      ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (prev !== undefined) process.env["ANTHROPIC_API_KEY"] = prev;
    }
  });
});
