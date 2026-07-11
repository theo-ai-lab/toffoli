import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS, parseCliArgs, renderCommandHelp, renderHelp, runCli } from "./cli";

describe("cli — argument parsing (pure)", () => {
  it("parses each subcommand", () => {
    for (const cmd of COMMANDS) {
      const inv = parseCliArgs([cmd]);
      expect(inv.command).toBe(cmd);
      expect(inv.error).toBeNull();
    }
  });

  it("treats no arguments as 'nothing to do' (no command, no error — main shows usage)", () => {
    const inv = parseCliArgs([]);
    expect(inv.command).toBeNull();
    expect(inv.error).toBeNull();
    expect(inv.help).toBe(false);
  });

  it("accepts -h/--help globally and per command", () => {
    expect(parseCliArgs(["--help"]).help).toBe(true);
    expect(parseCliArgs(["-h"]).help).toBe(true);
    const inv = parseCliArgs(["classify", "--help"]);
    expect(inv.help).toBe(true);
    expect(inv.command).toBe("classify");
  });

  it("accepts -V/--version", () => {
    expect(parseCliArgs(["--version"]).version).toBe(true);
    expect(parseCliArgs(["-V"]).version).toBe(true);
  });

  it("rejects an unknown command with a usage error", () => {
    const inv = parseCliArgs(["undelete"]);
    expect(inv.error).toMatch(/unknown command 'undelete'/i);
  });

  it("rejects an unknown flag with a usage error", () => {
    expect(parseCliArgs(["demo", "--fast"]).error).toMatch(/unknown option '--fast'/i);
  });

  it("classify: takes an input file, '-' for stdin, and its two flags", () => {
    const inv = parseCliArgs(["classify", "actions.json", "--deterministic-only", "--compact"]);
    expect(inv.command).toBe("classify");
    expect(inv.file).toBe("actions.json");
    expect(inv.deterministicOnly).toBe(true);
    expect(inv.compact).toBe(true);
    expect(parseCliArgs(["classify", "-"]).file).toBe("-");
    expect(parseCliArgs(["classify"]).file).toBeNull();
  });

  it("classify flags are rejected on other commands (no silent no-ops)", () => {
    expect(parseCliArgs(["demo", "--deterministic-only"]).error).toMatch(/only valid with 'classify'/i);
    expect(parseCliArgs(["mcp", "--compact"]).error).toMatch(/only valid with 'classify'/i);
  });

  it("rejects a stray positional argument on commands that take none", () => {
    expect(parseCliArgs(["demo", "extra"]).error).toMatch(/unexpected argument/i);
    expect(parseCliArgs(["classify", "a.json", "b.json"]).error).toMatch(/unexpected argument/i);
  });
});

describe("cli — help text", () => {
  it("the top-level help names every subcommand and the env vars", () => {
    const help = renderHelp();
    for (const cmd of COMMANDS) expect(help).toContain(cmd);
    expect(help).toContain("ANTHROPIC_API_KEY");
    expect(help).toContain("TOFFOLI_EXECUTE_DISABLED");
    expect(help).toContain("TOFFOLI_MCP_FS_ROOT");
  });

  it("every subcommand has its own help with a Usage line", () => {
    for (const cmd of COMMANDS) {
      const help = renderCommandHelp(cmd);
      expect(help).toContain(`toffoli ${cmd}`);
      expect(help).toMatch(/usage/i);
    }
  });

  it("the top-level help carries worked examples for the copy-paste path", () => {
    const help = renderHelp();
    expect(help).toContain("Examples");
    expect(help).toContain("toffoli classify - < run.json");
    expect(help).toContain("TOFFOLI_EXECUTE_DISABLED=1 toffoli mcp");
  });

  it("classify's help includes a runnable stdin example", () => {
    const help = renderCommandHelp("classify");
    expect(help).toContain("Examples");
    // The example JSON must be a valid AgentAction — keep it honest by parsing it.
    const json = help.match(/echo '(\{.*\})'/)?.[1];
    expect(json).toBeDefined();
    const parsed = JSON.parse(json as string) as { id: string; tool: string };
    expect(parsed.id).toBeTruthy();
    expect(parsed.tool).toBeTruthy();
  });
});

describe("cli — runCli classify (in-process, deterministic-only)", () => {
  let out = "";
  let err = "";
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let dir: string;

  beforeEach(() => {
    out = "";
    err = "";
    const cap = (sink: "out" | "err") =>
      ((chunk: unknown) => {
        const s = typeof chunk === "string" ? chunk : String(chunk);
        if (sink === "out") out += s;
        else err += s;
        return true;
      }) as typeof process.stdout.write;
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation(cap("out"));
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(cap("err"));
    dir = mkdtempSync(join(tmpdir(), "toffoli-cli-"));
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("classifies a file of actions and exits 0", async () => {
    const f = join(dir, "actions.json");
    writeFileSync(f, JSON.stringify([{ id: "a1", tool: "email.send", op: "send", target: { kind: "email", externalized: true } }]));
    const code = await runCli(["classify", f, "--deterministic-only", "--compact"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Array<{ class: string; llmAssisted: boolean }>;
    expect(parsed[0]?.class).toBe("IRREVERSIBLE");
    expect(parsed[0]?.llmAssisted).toBe(false);
  });

  it("a missing file is a clean usage error (exit 2, no stack trace)", async () => {
    const code = await runCli(["classify", join(dir, "nope.json")]);
    expect(code).toBe(2);
    expect(err).toContain("cannot read file");
    expect(err).not.toContain("at readFileSync");
  });

  it("invalid JSON is a clean usage error (exit 2)", async () => {
    const f = join(dir, "bad.json");
    writeFileSync(f, "{ not json");
    const code = await runCli(["classify", f]);
    expect(code).toBe(2);
    expect(err).toContain("not valid JSON");
  });

  it("an action that fails validation is a clean usage error naming the index (exit 2)", async () => {
    const f = join(dir, "invalid-action.json");
    writeFileSync(f, JSON.stringify([{ tool: "email.send" }])); // missing required id
    const code = await runCli(["classify", f]);
    expect(code).toBe(2);
    expect(err).toContain("classify input [0]");
  });
});
