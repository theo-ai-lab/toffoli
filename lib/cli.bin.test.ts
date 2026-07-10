/**
 * The packaged binary, tested as a stranger runs it.
 *
 * Builds the real dist bundle (the exact esbuild invocation `npm run build` uses) into a temp
 * directory with NO node_modules anywhere above it, then drives it as a child process. That cold
 * layout is the regression lock for the lazy-judge design: if anything on the server/demo path
 * statically imported @anthropic-ai/sdk (or any other package), esbuild would hoist it as a
 * top-level external import and the cold start would crash with ERR_MODULE_NOT_FOUND.
 *
 * `toffoli eval` needs zod (dataset validation) + the .jsonl gold set, so it is exercised from a
 * bundle placed INSIDE the repo instead — proving the dataset loader's package-root resolution
 * works from the dist layout while externals resolve from the repo's node_modules.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;

/** Mirror of the `npm run build` esbuild flags (kept in one place for the test). */
async function bundleInto(outdir: string): Promise<string> {
  await build({
    entryPoints: [join(REPO_ROOT, "lib/cli.ts")],
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
    outdir,
    entryNames: "toffoli",
    chunkNames: "chunks/[name]-[hash]",
    banner: { js: "#!/usr/bin/env node" },
    logLevel: "warning",
  });
  return join(outdir, "toffoli.js");
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the bin with args; optionally write stdin (closed after). No API key ever reaches it. */
function runBin(bin: string, args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env["ANTHROPIC_API_KEY"];
    const child = spawn(process.execPath, [bin, ...args], { env, cwd: dirname(bin) });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

let coldDir: string; // under the OS tmpdir — no node_modules in any ancestor
let coldBin: string;
let repoDir: string; // under the repo root — externals + dataset resolve
let repoBin: string;

beforeAll(async () => {
  coldDir = mkdtempSync(join(tmpdir(), "toffoli-bin-"));
  repoDir = mkdtempSync(join(REPO_ROOT, ".bin-test-"));
  [coldBin, repoBin] = await Promise.all([bundleInto(coldDir), bundleInto(repoDir)]);
}, 60_000);

afterAll(() => {
  rmSync(coldDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe("toffoli bin — cold start (no node_modules above the bundle, no API key)", () => {
  it("--help exits 0 and lists every subcommand", async () => {
    const r = await runBin(coldBin, ["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["demo", "classify", "recover", "eval", "mcp"]) expect(r.stdout).toContain(cmd);
  });

  it("--version prints the package version", async () => {
    // The cold bundle sits outside the repo, so the nearest-package.json walk finds nothing known —
    // this asserts the flag works; the true version value is asserted on the in-repo bundle below.
    const r = await runBin(coldBin, ["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  it("demo prints the restitution receipt deterministically", async () => {
    const r = await runBin(coldBin, ["demo"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("TOFFOLI — RESTITUTION RECEIPT");
    expect(r.stdout).toContain("VERDICT");
  });

  it("recover runs the sandboxed end-to-end loop", async () => {
    const r = await runBin(coldBin, ["recover"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("END-TO-END RECOVERY");
    expect(r.stdout).toContain("actions auto-executed: 0.");
  });

  it("classify reads stdin and prints classifications (deterministic-only)", async () => {
    const action = { id: "a1", tool: "email.send", op: "send", target: { kind: "email", externalized: true } };
    const r = await runBin(coldBin, ["classify", "-", "--deterministic-only", "--compact"], JSON.stringify(action));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as Array<{ actionId: string; class: string; llmAssisted: boolean }>;
    expect(out).toHaveLength(1);
    expect(out[0]!.class).toBe("IRREVERSIBLE");
    expect(out[0]!.llmAssisted).toBe(false);
  });

  it("mcp serves initialize + tools/list with no API key and no resolvable SDK", async () => {
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bin-test", version: "0" } },
    });
    const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const r = await runBin(coldBin, ["mcp"], `${initialize}\n${list}\n`);
    // @modelcontextprotocol/sdk is unresolvable from the cold dir → the zero-dep loop must serve.
    expect(r.stderr).toContain("hand-rolled stdio server ready");
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as { id: number; result: Record<string, unknown> });
    expect(lines[0]!.result["serverInfo"]).toMatchObject({ name: "toffoli-mcp" });
    const tools = (lines[1]!.result["tools"] as Array<{ name: string }>).map((t) => t.name);
    expect(tools).toEqual(["toffoli.checkpoint", "toffoli.classify", "toffoli.recover"]);
  });

  it("an unknown command exits 2 with usage on stderr", async () => {
    const r = await runBin(coldBin, ["undelete"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown command 'undelete'");
    expect(r.stderr).toContain("Usage");
  });
});

describe("toffoli bin — in-repo bundle (externals + dataset resolvable)", () => {
  it("--version reports the real package version via the package-root walk", async () => {
    const r = await runBin(repoBin, ["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(PKG_VERSION);
  });

  it("eval loads the gold set from the package root and prints the headline", async () => {
    const r = await runBin(repoBin, ["eval"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("HEADLINE");
    expect(r.stdout).toContain("IRREVERSIBLE recall");
  }, 30_000);
});
