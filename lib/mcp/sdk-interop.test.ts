/**
 * Official-SDK interop: the REAL @modelcontextprotocol/sdk client drives the REAL Toffoli server
 * over stdio, cross-process, with NO API key anywhere in the child's environment.
 *
 * What this proves (and lib/mcp/host.test.ts's hand-rolled client cannot):
 *  - the server speaks MCP as the official implementation expects — handshake, tools/list,
 *    tools/call, structuredContent — not merely as our own client expects;
 *  - with the SDK installed (a devDependency), the server entry's `createSdkServer` path is the
 *    one being exercised, so the official transport is tested rather than permanently deferred;
 *  - the whole loop is key-free: the judge stays gated off and classification is deterministic.
 *
 * See docs/HOST_INTEGRATION.md for wiring real hosts (the `claude` CLI, MCP Inspector) the same way.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const SERVER_SCRIPT = join(HERE, "server.ts");

/** The child's env: the inherited one MINUS any API key — the run must be key-free end to end. */
function keyFreeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "ANTHROPIC_API_KEY") env[k] = v;
  }
  return env;
}

let client: Client;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [require.resolve("tsx/cli"), SERVER_SCRIPT], // exactly what `npm run mcp` runs
    cwd: REPO_ROOT,
    env: keyFreeEnv(),
    stderr: "pipe", // keep the server's readiness line out of the test output
  });
  client = new Client({ name: "toffoli-sdk-interop-test", version: "0.0.0" });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client.close();
});

describe("MCP interop — official SDK client ↔ Toffoli server over stdio, key-free", () => {
  it("completes the MCP handshake with the real server identity", () => {
    const serverVersion = client.getServerVersion();
    expect(serverVersion).toMatchObject({ name: "toffoli-mcp" });
  });

  it("lists the three Toffoli tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["toffoli.checkpoint", "toffoli.classify", "toffoli.recover"]);
  });

  it("calls toffoli.classify and gets a deterministic (never judged) verdict without a key", async () => {
    const result = await client.callTool({
      name: "toffoli.classify",
      arguments: {
        action: { id: "a1", tool: "email.send", op: "send", target: { kind: "email", externalized: true } },
      },
    });
    expect(result.isError ?? false).toBe(false);
    const out = result.structuredContent as {
      classification: { class: string };
      requiresHuman: boolean;
      judged: boolean;
    };
    expect(out.classification.class).toBe("IRREVERSIBLE");
    expect(out.requiresHuman).toBe(true);
    expect(out.judged).toBe(false); // no ANTHROPIC_API_KEY in the child ⇒ the judge never ran
  });

  it("checkpoints, then recover (plan-only) verifies against that checkpoint without mutating", async () => {
    const cp = await client.callTool({ name: "toffoli.checkpoint", arguments: { label: "sdk-interop" } });
    const checkpointId = (cp.structuredContent as { checkpointId: string }).checkpointId;
    expect(checkpointId).toBeTruthy();

    const rec = await client.callTool({
      name: "toffoli.recover",
      arguments: {
        actions: [{ id: "a1", tool: "fs.write", op: "create", target: { kind: "file", id: "/tmp/x" } }],
        checkpointId,
      },
    });
    const out = rec.structuredContent as {
      executed: boolean;
      confirmToken: string;
      checkpoint?: { found: boolean };
    };
    expect(out.executed).toBe(false); // plan-only by default — nothing mutated
    expect(out.confirmToken).toBeTruthy();
    expect(out.checkpoint?.found).toBe(true);
  });

  it("surfaces a malformed call as an MCP tool error, not a crash", async () => {
    const result = await client.callTool({ name: "toffoli.classify", arguments: {} });
    expect(result.isError).toBe(true);
  });
});
