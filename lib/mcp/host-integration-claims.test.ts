/**
 * Doc-truth lock: the protocol-negotiation claim in docs/HOST_INTEGRATION.md must be scoped to the
 * transport that actually enforces it.
 *
 * `negotiateProtocolVersion()` — and its locks in server.test.ts / pack-smoke.test.ts — belong to the
 * hand-rolled, zero-dependency stdio loop, i.e. the transport an INSTALLED user gets. They do not
 * apply to `createSdkServer`: there the handshake belongs to `@modelcontextprotocol/sdk`, which
 * negotiates against ITS OWN supported set, and `SUPPORTED_PROTOCOL_VERSIONS` is not threaded into
 * it. Every way this repo documents running the server from a clone resolves the devDependency and
 * therefore takes the SDK path, so a guarantee stated unqualified across both transports is false on
 * the path readers will actually run.
 *
 * This file pins BOTH halves so they cannot drift apart:
 *   - the executable behaviour of each transport, probed for real (the clone path is spawned exactly
 *     as `npm run mcp` spawns it);
 *   - the doc text, which must name the observed answer per transport. If someone later threads the
 *     supported set into createSdkServer, the observed answer changes and this file goes red until
 *     the doc is corrected in the same commit — which is the point.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, negotiateProtocolVersion } from "./server";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const DOC_PATH = join(REPO_ROOT, "docs", "HOST_INTEGRATION.md");

/** The doc with runs of whitespace collapsed: assertions survive re-wrapping, but not rewording. */
const DOC = readFileSync(DOC_PATH, "utf8").replace(/\s+/g, " ");

/**
 * Run EXACTLY what `npm run mcp` runs — the clone path documented under "Run the server" — send one
 * raw `initialize`, and return the revision the server answers with. No SDK client here on purpose:
 * this reads the wire, so it records what the server said rather than what a client tolerated.
 */
function negotiatedOverDocumentedClonePath(requested: string): Promise<string> {
  const require = createRequire(import.meta.url);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve("tsx/cli"), join(HERE, "server.ts")], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "ignore"], // stderr dropped: the readiness line is not under test
    });
    let buffered = "";
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      child.kill();
      fn();
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      if (!buffered.includes("\n")) return;
      const line = buffered.slice(0, buffered.indexOf("\n"));
      settle(() => {
        try {
          const answered = (JSON.parse(line) as { result?: { protocolVersion?: unknown } }).result?.protocolVersion;
          if (typeof answered !== "string") reject(new Error(`no protocolVersion in initialize response: ${line}`));
          else resolve(answered);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", () => settle(() => reject(new Error("server exited before answering initialize"))));
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: requested,
          capabilities: {},
          clientInfo: { name: "host-integration-claims", version: "0.0.0" },
        },
      })}\n`,
    );
  });
}

/**
 * Assert on the doc without dumping the whole file into the failure message: the diff of a 6 kB
 * string against a 60-character needle is unreadable, and an unreadable lock gets deleted.
 */
function docSays(needle: string): void {
  expect(DOC.includes(needle), `docs/HOST_INTEGRATION.md must say: ${needle}`).toBe(true);
}
function docDoesNotSay(needle: string): void {
  expect(DOC.includes(needle), `docs/HOST_INTEGRATION.md must NOT say: ${needle}`).toBe(false);
}

describe("docs/HOST_INTEGRATION.md — the protocol-negotiation claim is scoped to the transport that enforces it", () => {
  it("the built-in transport is the one that enforces SUPPORTED_PROTOCOL_VERSIONS", () => {
    expect([...SUPPORTED_PROTOCOL_VERSIONS]).toEqual([PROTOCOL_VERSION]);
    for (const requested of [LATEST_PROTOCOL_VERSION, "9999-12-31", "1999-01-01", "not-a-version"]) {
      expect(negotiateProtocolVersion(requested)).toBe(PROTOCOL_VERSION);
    }
  });

  it("the documented clone path does NOT enforce it — the SDK negotiates against its own set", async () => {
    const answered = await negotiatedOverDocumentedClonePath(LATEST_PROTOCOL_VERSION);
    expect(answered).toBe(LATEST_PROTOCOL_VERSION);
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain(answered);
  }, 60_000);

  it("on that path an unknown revision gets the SDK's own latest, not this server's default", async () => {
    const answered = await negotiatedOverDocumentedClonePath("9999-12-31");
    expect(answered).toBe(LATEST_PROTOCOL_VERSION);
    expect(answered).not.toBe(PROTOCOL_VERSION);
  }, 60_000);

  it("the doc no longer asserts the guarantee across BOTH transports", () => {
    // Two markers of the unqualified form, both genuinely false as written:
    //  1. the unscoped opener, asserted straight after a table listing BOTH transports;
    docDoesNotSay("The server implements the **`2025-06-18`** protocol revision and negotiates against that set");
    //  2. attributing the downgrade to the official SDK's client — precisely the case that reaches
    //     the SDK transport, where the third test above shows no downgrade happens.
    docDoesNotSay("which is what the official SDK's client asks for today");
  });

  it("the doc states the guarantee per transport, and names each transport's observed answer", async () => {
    docSays("On the built-in transport");
    docSays("On the SDK transport");
    // The doc must quote what each transport actually answered above — not an aspiration.
    docSays(`is answered with \`${negotiateProtocolVersion(LATEST_PROTOCOL_VERSION)}\`, never with the revision it named`);
    const overSdk = await negotiatedOverDocumentedClonePath(LATEST_PROTOCOL_VERSION);
    docSays(`this path answers \`${overSdk}\``);
  }, 60_000);
});
