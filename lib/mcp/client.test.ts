import { describe, expect, it } from "vitest";
import { World } from "../exec/world";
import { ToffoliMcpClient, type McpTransport } from "./client";
import { createDeps, handleRpcMessage, type ToffoliMcpDeps } from "./server";

/**
 * An in-process transport that wires the client's `send` straight into the REAL server dispatcher
 * (handleRpcMessage) and replays the response as an NDJSON line. This exercises the entire protocol
 * — request framing, id correlation, tool-result decoding, the isError channel — against the actual
 * server code, deterministically and with no subprocess. The cross-process stdio path is covered in
 * host.test.ts.
 */
class InProcessTransport implements McpTransport {
  private onMsg: ((chunk: string) => void) | null = null;

  constructor(private readonly deps: ToffoliMcpDeps) {}

  send(raw: string): void {
    // Mirror the wire: the server reads NDJSON lines and emits NDJSON responses.
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const message = JSON.parse(t);
      void handleRpcMessage(this.deps, message).then((resp) => {
        if (resp && this.onMsg) this.onMsg(`${JSON.stringify(resp)}\n`);
      });
    }
  }
  onMessage(cb: (chunk: string) => void): void {
    this.onMsg = cb;
  }
  onClose(): void {
    /* in-process transport never closes on its own */
  }
  close(): void {
    this.onMsg = null;
  }
}

/** Build a client wired to a fresh in-process server over the given (seeded) world. */
function connect(world = new World()): { client: ToffoliMcpClient; deps: ToffoliMcpDeps; world: World } {
  let n = 0;
  const deps = createDeps({
    world,
    judge: undefined, // deterministic-only: offline, cost-free, reproducible
    env: {} as NodeJS.ProcessEnv, // no kill-switch
    newId: () => `cp-${++n}`,
    now: () => "2026-06-18T00:00:00Z",
  });
  const client = new ToffoliMcpClient(new InProcessTransport(deps), { requestTimeoutMs: 2000 });
  return { client, deps, world };
}

describe("ToffoliMcpClient — protocol round trip against the real server dispatcher", () => {
  it("initialize + tools/list returns the three Toffoli tools", async () => {
    const { client } = connect();
    const info = await client.initialize();
    expect(info.serverInfo.name).toBe("toffoli-mcp");
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["toffoli.checkpoint", "toffoli.classify", "toffoli.recover"]);
    client.close();
  });

  it("checkpoint snapshots the world and returns a checkpointId", async () => {
    const world = new World();
    world.seedRow("orders", "1", { customer: "acme" });
    const { client } = connect(world);
    await client.initialize();

    const cp = await client.checkpoint({ label: "pre" });
    expect(cp.checkpointId).toBe("cp-1");
    expect(cp.label).toBe("pre");
    expect(cp.snapshot.rows["orders:1"]).toEqual({ customer: "acme" });
    client.close();
  });

  it("classify: a recoverable delete is reversible; an external send needs a human", async () => {
    const world = new World();
    world.seedRow("orders", "1", { customer: "acme" });
    const { client } = connect(world);
    await client.initialize();

    const del = world.softDeleteRow("orders", "1");
    const delRes = await client.classify({ action: del, deterministicOnly: true });
    expect(delRes.classification.class).toBe("REVERSIBLE");
    expect(delRes.recoverable).toBe(true);
    expect(delRes.requiresHuman).toBe(false);

    const mail = world.sendEmail("x@corp.test", "hi");
    const mailRes = await client.classify({ action: mail, deterministicOnly: true });
    expect(mailRes.classification.class).toBe("IRREVERSIBLE");
    expect(mailRes.requiresHuman).toBe(true);
    client.close();
  });

  it("recover is plan-only by default, then executes when re-presented its plan-bound token, verified vs a checkpoint", async () => {
    const world = new World();
    world.seedRow("orders", "1", { customer: "acme" });
    const baseline = world.snapshot();
    const { client } = connect(world);
    await client.initialize();

    const cp = await client.checkpoint({ label: "pre" });
    const del = world.softDeleteRow("orders", "1"); // the agent's damage

    // plan-only: mutates nothing, returns a confirm token.
    const planOnly = await client.recover({ actions: [del], deterministicOnly: true });
    expect(planOnly.executed).toBe(false);
    expect(planOnly.report.phase).toBe("plan-only");
    expect("orders:1" in world.snapshot().rows).toBe(false); // still gone

    // execute: re-present the token; the row is genuinely restored and matches the checkpoint.
    const executed = await client.recover({
      actions: [del],
      deterministicOnly: true,
      confirmToken: planOnly.confirmToken,
      checkpointId: cp.checkpointId,
    });
    expect(executed.executed).toBe(true);
    expect(executed.report.phase).toBe("executed");
    expect(executed.report.restored).toBe(1);
    expect(executed.report.fabricationCheck.pass).toBe(true);
    expect(executed.checkpoint?.recoverableMatchesCheckpoint).toBe(true);
    expect(world.snapshot().rows).toEqual(baseline.rows);
    client.close();
  });

  it("autoConfirm + sandbox restores the recoverable subset and escalates the irreversible send", async () => {
    const world = new World();
    world.seedRow("orders", "1", { customer: "acme" });
    const baseline = world.snapshot();
    const del = world.softDeleteRow("orders", "1");
    const chg = world.charge("enrich-api", 9);
    const mail = world.sendEmail("x@corp.test", "hi");
    const { client } = connect(world);
    await client.initialize();

    const res = await client.recover({ actions: [del, chg, mail], deterministicOnly: true, autoConfirm: true, policy: "sandbox" });
    expect(res.executed).toBe(true);
    expect(res.report.restored).toBe(2); // row restore + refund
    expect(res.report.escalations.some((e) => e.kind === "irreversible")).toBe(true);

    const after = world.snapshot();
    expect(after.rows).toEqual(baseline.rows);
    expect(after.ledgerUsd).toBe(baseline.ledgerUsd);
    expect(after.outbox).toHaveLength(1); // the email stays sent
    client.close();
  });

  it("surfaces a tool-level error (malformed input) as a thrown McpToolError, not a resolved value", async () => {
    const { client } = connect();
    await client.initialize();
    await expect(client.recover({ actions: [] })).rejects.toThrow(/non-empty 'actions'/);
    client.close();
  });

  it("rejects in-flight requests when the client is closed", async () => {
    const { client } = connect();
    await client.initialize();
    const pending = client.recover({ actions: [] }).catch((e: Error) => e.message);
    client.close();
    // Either the tool error or the close rejection settles it — both are rejections, never a hang.
    await expect(Promise.resolve(pending)).resolves.toMatch(/actions|closed/);
  });
});
