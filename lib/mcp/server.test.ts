import { describe, it, expect } from "vitest";
import {
  createDeps,
  handleCheckpoint,
  handleClassify,
  handleRecover,
  callToolByName,
  handleRpcMessage,
  TOOL_DEFINITIONS,
  type ToffoliMcpDeps,
} from "./server";
import { World } from "../exec/world";

// Inject an empty env (no kill-switch) and the deterministic-only path (judge omitted), so the
// server is offline and reproducible — no API key, no wall-clock, no random ids.
const noEnv = {} as NodeJS.ProcessEnv;

function makeDeps(world = new World()): ToffoliMcpDeps {
  let n = 0;
  return createDeps({
    world,
    judge: undefined, // deterministic rules only (offline, cost-free)
    env: noEnv,
    newId: () => `cp-${++n}`,
    now: () => "2026-06-14T00:00:00Z",
  });
}

describe("toffoli MCP tool handlers", () => {
  it("checkpoint snapshots the world and stores it under the returned id (read-only)", () => {
    const world = new World();
    world.seedRow("orders", "1", { customer: "acme" });
    const deps = makeDeps(world);

    const res = handleCheckpoint(deps, { label: "before-cleanup" });
    expect(res.checkpointId).toBe("cp-1");
    expect(res.label).toBe("before-cleanup");
    expect(res.takenAt).toBe("2026-06-14T00:00:00Z");
    expect(res.snapshot.rows["orders:1"]).toEqual({ customer: "acme" });
    expect(deps.checkpoints.get("cp-1")).toBeDefined();
    // read-only: the world is unchanged by a checkpoint
    expect(world.snapshot().rows["orders:1"]).toEqual({ customer: "acme" });
  });

  it("classify: a recoverable delete is reversible; an external send needs a human (deterministic-only)", async () => {
    const world = new World();
    world.seedRow("orders", "1", { customer: "acme" });
    const deps = makeDeps(world);

    const del = world.softDeleteRow("orders", "1"); // genuine action: db.row, recoverable copy
    const delRes = await handleClassify(deps, { action: del, deterministicOnly: true });
    expect(delRes.classification.class).toBe("REVERSIBLE");
    expect(delRes.recoverable).toBe(true);
    expect(delRes.requiresHuman).toBe(false);
    expect(delRes.judged).toBe(false);

    const mail = world.sendEmail("x@corp.test", "hi"); // genuine action: externalized email
    const mailRes = await handleClassify(deps, { action: mail, deterministicOnly: true });
    expect(mailRes.classification.class).toBe("IRREVERSIBLE");
    expect(mailRes.requiresHuman).toBe(true);
    expect(mailRes.recoverable).toBe(false);
  });

  it("recover is PLAN-ONLY by default: nothing mutates, and a plan-bound confirm token comes back", async () => {
    const world = new World();
    world.seedRow("orders", "1", { customer: "acme" });
    const del = world.softDeleteRow("orders", "1"); // row now soft-deleted
    const deps = makeDeps(world);

    const res = await handleRecover(deps, { actions: [del] });
    expect(res.executed).toBe(false);
    expect(res.report.phase).toBe("plan-only");
    expect(res.confirmToken).toMatch(/^[0-9a-f]{32}$/);
    // plan-only mutates nothing: the row is still gone, NOT restored
    expect("orders:1" in world.snapshot().rows).toBe(false);
  });

  it("recover executes only when re-presented its plan-bound confirm token", async () => {
    const world = new World();
    world.seedRow("orders", "1", { customer: "acme" });
    const baseline = world.snapshot();
    const del = world.softDeleteRow("orders", "1");
    const deps = makeDeps(world);

    const planOnly = await handleRecover(deps, { actions: [del] });
    const executed = await handleRecover(deps, { actions: [del], confirmToken: planOnly.confirmToken });

    expect(executed.executed).toBe(true);
    expect(executed.report.phase).toBe("executed");
    expect(executed.report.restored).toBe(1);
    expect(world.snapshot().rows).toEqual(baseline.rows); // the row is genuinely back
  });

  it("recover autoConfirm + sandbox runs the recoverable subset and escalates the irreversible send", async () => {
    const world = new World();
    world.seedRow("orders", "1", { customer: "acme" });
    const baseline = world.snapshot();
    const del = world.softDeleteRow("orders", "1");
    const chg = world.charge("enrich-api", 9);
    const mail = world.sendEmail("x@corp.test", "hi");
    const deps = makeDeps(world);

    const res = await handleRecover(deps, { actions: [del, chg, mail], autoConfirm: true, policy: "sandbox" });
    expect(res.executed).toBe(true);
    expect(res.report.restored).toBe(2); // row restore + refund
    expect(res.report.escalations.some((e) => e.kind === "irreversible")).toBe(true);
    expect(res.report.fabricationCheck.pass).toBe(true);

    const after = world.snapshot();
    expect(after.rows).toEqual(baseline.rows);
    expect(after.ledgerUsd).toBe(baseline.ledgerUsd);
    expect(after.outbox).toHaveLength(1); // the email stays sent
  });

  it("recover verifies the recoverable subset against a prior checkpoint", async () => {
    const world = new World();
    world.seedRow("orders", "1", { customer: "acme" });
    const deps = makeDeps(world);

    const cp = handleCheckpoint(deps, { label: "pre" });
    const del = world.softDeleteRow("orders", "1");
    const planOnly = await handleRecover(deps, { actions: [del] });
    const res = await handleRecover(deps, {
      actions: [del],
      confirmToken: planOnly.confirmToken,
      checkpointId: cp.checkpointId,
    });

    expect(res.checkpoint?.found).toBe(true);
    expect(res.checkpoint?.recoverableMatchesCheckpoint).toBe(true);
  });

  it("rejects malformed recover input (empty actions array)", async () => {
    const deps = makeDeps();
    await expect(handleRecover(deps, { actions: [] })).rejects.toThrow(/non-empty 'actions'/);
  });
});

describe("toffoli MCP JSON-RPC protocol layer", () => {
  it("tools/list advertises exactly the three Toffoli tools", async () => {
    const deps = makeDeps();
    const resp = await handleRpcMessage(deps, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(resp?.result).toEqual({ tools: TOOL_DEFINITIONS });
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual(["toffoli.checkpoint", "toffoli.classify", "toffoli.recover"]);
  });

  it("tools/call dispatches to a handler; an unknown tool comes back as an isError result", async () => {
    const deps = makeDeps();
    const ok = await callToolByName(deps, "toffoli.checkpoint", { label: "x" });
    expect(ok.isError).toBe(false);
    const bad = await callToolByName(deps, "does.not.exist", {});
    expect(bad.isError).toBe(true);
  });

  it("a notification (no id) yields no reply; an unknown method returns -32601", async () => {
    const deps = makeDeps();
    const note = await handleRpcMessage(deps, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note).toBeNull();
    const unknown = await handleRpcMessage(deps, { jsonrpc: "2.0", id: 7, method: "bogus" });
    expect(unknown?.error?.code).toBe(-32601);
  });
});
