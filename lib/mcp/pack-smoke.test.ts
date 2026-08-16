/**
 * The MCP server, driven out of the PACKED ARTIFACT — what a stranger actually installs.
 *
 * `@modelcontextprotocol/sdk` is a devDependency and stays one (the runtime-dependency budget is
 * two: @anthropic-ai/sdk + zod). So the transport an installed user gets is NEVER the official
 * server transport — it is the hand-rolled, zero-dependency stdio JSON-RPC loop in server.ts.
 * That path is therefore the supported one, and this file is its end-to-end lock:
 *
 *   npm run build → npm pack → extract → spawn `toffoli mcp` from the tarball's own layout,
 *   with no node_modules anywhere above it, and drive it BOTH raw and with the official
 *   MCP client from this repo's devDependencies.
 *
 * Two things this catches that the in-repo tests cannot:
 *   1. a tarball that ships without the bin (`files` / `bin` drift) — the packed layout is used,
 *      not the repo's;
 *   2. a protocol answer that only looks right when the SDK is present to paper over it — here the
 *      server side has no SDK to fall back on, so the hand-rolled negotiation is what replies to a
 *      real client asking for a revision this server does not implement.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./server";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { bin: Record<string, string> };

/** The child's env: inherited MINUS any API key — the packed server must run key-free. */
function keyFreeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "ANTHROPIC_API_KEY") env[k] = v;
  }
  return env;
}

let packDir: string; // under the OS tmpdir — no node_modules in ANY ancestor
let packedBin: string;

beforeAll(() => {
  packDir = mkdtempSync(join(tmpdir(), "toffoli-pack-"));
  // Build explicitly, then pack with lifecycle scripts off — the tarball content is exactly what a
  // publish from this commit would ship (prepack would run the same build).
  execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
  const out = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: "pipe",
  });
  const tarball = join(packDir, out.trim().split("\n").pop()!.trim());
  execFileSync("tar", ["-xzf", tarball, "-C", packDir], { stdio: "pipe" });
  // npm tarballs unpack under `package/`; the bin path is read from package.json, never hardcoded,
  // so a `bin` rename that forgets the build output fails here instead of on a user's machine.
  packedBin = join(packDir, "package", PKG.bin["toffoli"]!);
}, 180_000);

afterAll(() => {
  rmSync(packDir, { recursive: true, force: true });
});

/** Drive the packed bin over raw stdio NDJSON and collect one response per request line. */
function driveRaw(requests: unknown[]): { responses: Array<Record<string, unknown>>; stderr: string } {
  const stdin = `${requests.map((r) => JSON.stringify(r)).join("\n")}\n`;
  const res = execFileSync(process.execPath, [packedBin, "mcp"], {
    input: stdin,
    cwd: dirname(packedBin),
    env: keyFreeEnv(),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { responses: res.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>), stderr: "" };
}

describe("packed artifact — the MCP server a stranger installs", () => {
  it("ships the bin the package.json `bin` entry points at", () => {
    expect(existsSync(packedBin)).toBe(true);
  });

  it("answers initialize with a revision it implements — never the one the client merely asked for", () => {
    const ask = (protocolVersion: string) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: { name: "pack-smoke", version: "0" } },
    });
    // A future revision (what the official SDK client asks for today) and a nonsense one.
    for (const requested of [LATEST_PROTOCOL_VERSION, "9999-12-31"]) {
      const { responses } = driveRaw([ask(requested)]);
      const result = responses[0]!["result"] as Record<string, unknown>;
      expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(result["protocolVersion"]);
      expect(result["protocolVersion"]).toBe(PROTOCOL_VERSION);
      expect(result["serverInfo"]).toMatchObject({ name: "toffoli-mcp" });
    }
  });

  it("serves tools/list and a deterministic tools/call from the tarball with no key and no node_modules", () => {
    const { responses } = driveRaw([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "toffoli.classify",
          arguments: { action: { id: "a1", tool: "email.send", op: "send", target: { kind: "email", externalized: true } }, deterministicOnly: true },
        },
      },
    ]);
    expect(responses).toHaveLength(3);
    const tools = ((responses[1]!["result"] as Record<string, unknown>)["tools"] as Array<{ name: string }>).map((t) => t.name);
    expect(tools).toEqual(["toffoli.checkpoint", "toffoli.classify", "toffoli.recover"]);
    const call = (responses[2]!["result"] as { isError?: boolean; structuredContent: { classification: { class: string; llmAssisted: boolean } } });
    expect(call.isError ?? false).toBe(false);
    expect(call.structuredContent.classification.class).toBe("IRREVERSIBLE");
    expect(call.structuredContent.classification.llmAssisted).toBe(false);
  });
});

describe("packed artifact ↔ the official MCP client (the zero-dependency transport, driven for real)", () => {
  let client: Client;
  let negotiated: string | undefined;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [packedBin, "mcp"],
      cwd: dirname(packedBin),
      env: keyFreeEnv(),
      stderr: "pipe",
    });
    // The client calls this with whatever the server negotiated — the only public seam that
    // exposes the negotiated revision on a stdio transport.
    (transport as unknown as { setProtocolVersion: (v: string) => void }).setProtocolVersion = (v) => {
      negotiated = v;
    };
    client = new Client({ name: "toffoli-pack-smoke", version: "0.0.0" });
    // connect() THROWS if the server answers with a revision the official client does not support —
    // so an "honest downgrade" that no real client accepts would fail right here.
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it("completes the official handshake against the packed bin and negotiates down to a real revision", () => {
    expect(client.getServerVersion()).toMatchObject({ name: "toffoli-mcp" });
    expect(negotiated).toBe(PROTOCOL_VERSION);
    expect(negotiated).not.toBe(LATEST_PROTOCOL_VERSION); // the client asked for the latest; the server did not pretend
  });

  it("lists and calls the three tools through the official client", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["toffoli.checkpoint", "toffoli.classify", "toffoli.recover"]);
    const result = await client.callTool({
      name: "toffoli.classify",
      arguments: { action: { id: "a1", tool: "db.delete", op: "delete", target: { kind: "db.row", id: "1" } }, deterministicOnly: true },
    });
    expect(result.isError ?? false).toBe(false);
    expect((result.structuredContent as { classification: { class: string } }).classification.class).toBe("IRREVERSIBLE");
  });
});
