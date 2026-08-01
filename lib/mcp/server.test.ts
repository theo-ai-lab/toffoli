import { describe, it, expect } from "vitest";
import {
  createDeps,
  handleCheckpoint,
  handleClassify,
  handleRecover,
  callToolByName,
  handleRpcMessage,
  TOOL_DEFINITIONS,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
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

describe("toffoli MCP protocol-version negotiation", () => {
  const initialize = async (protocolVersion?: unknown) => {
    const deps = makeDeps();
    const params = protocolVersion === undefined ? { capabilities: {} } : { protocolVersion, capabilities: {} };
    const resp = await handleRpcMessage(deps, { jsonrpc: "2.0", id: 1, method: "initialize", params });
    return (resp?.result as Record<string, unknown>)["protocolVersion"];
  };

  it("answers a supported revision with that same revision", async () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) expect(await initialize(v)).toBe(v);
  });

  it("NEVER answers with a revision it does not implement — an unknown request is downgraded, not echoed", async () => {
    // The failure this locks: echoing the client's requested version unconditionally makes the
    // server claim to speak any revision a client names (including future or nonsense ones) while
    // it only implements the tool surface of SUPPORTED_PROTOCOL_VERSIONS. The MCP spec requires the
    // server to answer with a version IT supports when it cannot honour the request.
    // `2025-11-25` is not hypothetical: it is what @modelcontextprotocol/sdk 1.29's client asks for.
    for (const v of ["2025-11-25", "9999-12-31", "1999-01-01", "not-a-version", ""]) {
      const answered = await initialize(v);
      expect(answered).not.toBe(v);
      expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(answered);
    }
  });

  it("a non-string or absent protocolVersion falls back to the latest supported revision", async () => {
    expect(await initialize(undefined)).toBe(PROTOCOL_VERSION);
    expect(await initialize(42)).toBe(PROTOCOL_VERSION);
    expect(await initialize(null)).toBe(PROTOCOL_VERSION);
  });

  it("the advertised default is the newest supported revision", () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS[0]).toBe(PROTOCOL_VERSION);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(PROTOCOL_VERSION);
  });
});
