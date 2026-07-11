/**
 * Toffoli — the single CLI entry. `toffoli <command>`.
 *
 * One packaged binary over the same entry points the npm scripts expose (the README's
 * command↔script mapping is unchanged; this is an ADDITIONAL surface, not a replacement):
 *
 *   toffoli demo      ≙ npm run demo      — the restitution receipt for the canonical run
 *   toffoli classify                      — classify AgentAction JSON from a file or stdin
 *   toffoli recover   ≙ npm run recover   — sandboxed damage → plan → undo → verify loop
 *   toffoli eval      ≙ npm run eval      — the per-class table over the gold set
 *   toffoli mcp       ≙ npm run mcp       — the MCP server (checkpoint/classify/recover) on stdio
 *
 * Design rules:
 *  - Zero-dependency arg parsing (hand-rolled, ~60 lines, exported pure for tests).
 *  - Subcommands load via dynamic import so the cold path stays cold: `toffoli mcp` starts
 *    with no ANTHROPIC_API_KEY and never resolves @anthropic-ai/sdk (the judge is lazy, see
 *    lib/engine/judge.ts); the eval/dataset machinery loads only for `toffoli eval`.
 *  - Packaged via esbuild (`npm run build` → dist/bin/toffoli.js) because the source uses
 *    extensionless bundler-style imports that Node cannot resolve unbundled.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentAction } from "./engine/types";

export const COMMANDS = ["demo", "classify", "recover", "eval", "mcp"] as const;
export type Command = (typeof COMMANDS)[number];

export interface CliInvocation {
  command: Command | null;
  help: boolean;
  version: boolean;
  /** classify's input: a path, "-" for stdin, or null (stdin when piped, usage error on a TTY). */
  file: string | null;
  deterministicOnly: boolean;
  compact: boolean;
  /** The first usage error, or null when the invocation is well-formed. */
  error: string | null;
}

/** Parse argv (after node + script). Pure — no I/O, no process access. */
export function parseCliArgs(argv: string[]): CliInvocation {
  const inv: CliInvocation = {
    command: null,
    help: false,
    version: false,
    file: null,
    deterministicOnly: false,
    compact: false,
    error: null,
  };
  const fail = (msg: string): CliInvocation => {
    if (inv.error === null) inv.error = msg;
    return inv;
  };

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      inv.help = true;
    } else if (arg === "-V" || arg === "--version") {
      inv.version = true;
    } else if (arg === "--deterministic-only" || arg === "--compact") {
      if (inv.command !== "classify") return fail(`option '${arg}' is only valid with 'classify'`);
      if (arg === "--compact") inv.compact = true;
      else inv.deterministicOnly = true;
    } else if (arg.startsWith("-") && arg !== "-") {
      return fail(`unknown option '${arg}'`);
    } else if (inv.command === null) {
      if (!(COMMANDS as readonly string[]).includes(arg)) return fail(`unknown command '${arg}'`);
      inv.command = arg as Command;
    } else if (inv.command === "classify" && inv.file === null) {
      inv.file = arg;
    } else {
      return fail(`unexpected argument '${arg}'`);
    }
  }
  return inv;
}

// ── help ────────────────────────────────────────────────────────────────────────

export function renderHelp(): string {
  return `toffoli — the undo layer for AI agents

Usage
  toffoli <command> [options]

Commands
  demo      print the restitution receipt for the canonical sample run
  classify  classify agent action(s) from JSON — a file path, or '-'/piped stdin
  recover   run the sandboxed end-to-end damage → plan → undo → verify loop
  eval      score the deterministic classifier per class over the labeled gold set
  mcp       serve the MCP tools (toffoli.checkpoint/classify/recover) over stdio

Options
  -h, --help     show help (or 'toffoli <command> --help' for one command)
  -V, --version  print the version

Examples
  toffoli demo                             the sample receipt, offline, zero config
  toffoli classify actions.json            classify a file of agent actions
  toffoli classify - < run.json            the same JSON on stdin
  toffoli classify - --deterministic-only  rules only — never consult the LLM judge
  TOFFOLI_EXECUTE_DISABLED=1 toffoli mcp   serve the MCP tools, recovery forced to dry-run

Environment
  ANTHROPIC_API_KEY         enables the gated LLM judge on the deterministic residual
  TOFFOLI_EXECUTE_DISABLED  kill-switch: recovery execution is forced to dry-run
  TOFFOLI_MCP_FS_ROOT       back the MCP server's recovery world with a real directory
`;
}

const COMMAND_HELP: Record<Command, string> = {
  demo: `Usage: toffoli demo

Feed the canonical sample agent run through the engine and print the restitution
receipt. Deterministic-only unless ANTHROPIC_API_KEY is set. Nothing is executed.
`,
  classify: `Usage: toffoli classify [file|-] [--deterministic-only] [--compact]

Read one AgentAction JSON object (or an array of them) from the file — or from
stdin with '-' or a pipe — classify each through the cascade (deterministic rules
first, the gated LLM judge on the residual, fail-safe to IRREVERSIBLE), and print
a JSON array of classifications to stdout.

Options
  --deterministic-only  rules only; never call the LLM judge
  --compact             single-line JSON output (default is pretty-printed)

Examples
  toffoli classify actions.json
  toffoli classify - --deterministic-only --compact < run.json
  echo '{"id":"a1","tool":"email.send","op":"send","target":{"kind":"email","externalized":true}}' \\
    | toffoli classify -
`,
  recover: `Usage: toffoli recover

Damage a sandboxed world with a scripted agent run, classify it, plan the
restitution, EXECUTE the recoverable subset, and verify the result against the
pre-damage baseline. Entirely in-memory — no real disk or network is touched.
`,
  eval: `Usage: toffoli eval

Score the deterministic classifier per class over the labeled gold set (plus an
at-scale synthetic held-out split). Numbers are classifier accuracy on fixtures,
not real-world prevalence.
`,
  mcp: `Usage: toffoli mcp

Start the Toffoli MCP server on stdio, exposing toffoli.checkpoint,
toffoli.classify and toffoli.recover. Uses @modelcontextprotocol/sdk's stdio
transport when that package is installed, else the built-in zero-dependency
JSON-RPC loop. Starts cold with no API key.

Environment
  TOFFOLI_MCP_FS_ROOT       back the recovery world with a real directory (FsWorld)
  TOFFOLI_EXECUTE_DISABLED  kill-switch: toffoli.recover is forced to dry-run
`,
};

export function renderCommandHelp(cmd: Command): string {
  return COMMAND_HELP[cmd];
}

// ── version (read from the nearest package.json: repo root at dev time, package root installed) ──

function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
      return pkg.version ?? "unknown";
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return "unknown";
      dir = parent;
    }
  }
}

// ── classify (the one subcommand implemented here rather than delegated) ─────────

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function runClassify(inv: CliInvocation): Promise<void> {
  if (inv.file === null && process.stdin.isTTY) {
    throw new UsageError("classify needs input: a file path, or JSON piped on stdin (see 'toffoli classify --help')");
  }
  let text: string;
  if (inv.file !== null && inv.file !== "-") {
    // A typo'd path is the most common classify mistake — route it through the exit-2 usage path
    // with a clean message instead of leaking a Node ENOENT stack trace out of the generic catch.
    try {
      text = readFileSync(inv.file, "utf8");
    } catch (e) {
      throw new UsageError(`cannot read file '${inv.file}': ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    text = await readStdin();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`classify input is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const rawActions = Array.isArray(parsed) ? parsed : [parsed];

  // One validator for this boundary shape, shared with the MCP server (the JSON is untrusted).
  const { parseAgentAction } = await import("./mcp/server");
  const { classifyAction, claudeJudge, isJudgeAvailable } = await import("./engine/index");

  const actions: AgentAction[] = rawActions.map((a, i) => {
    try {
      return parseAgentAction(a);
    } catch (e) {
      throw new UsageError(`classify input [${i}]: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  const judge = !inv.deterministicOnly && isJudgeAvailable() ? claudeJudge() : undefined;
  const out = [];
  for (const action of actions) out.push(await classifyAction(action, judge));
  process.stdout.write(`${inv.compact ? JSON.stringify(out) : JSON.stringify(out, null, 2)}\n`);
}

class UsageError extends Error {}

// ── dispatch ────────────────────────────────────────────────────────────────────

/** Run one parsed invocation. Returns the process exit code. */
export async function runCli(argv: string[]): Promise<number> {
  const inv = parseCliArgs(argv);

  if (inv.error !== null) {
    process.stderr.write(`toffoli: ${inv.error}\n\n${renderHelp()}`);
    return 2;
  }
  if (inv.version) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if (inv.help) {
    process.stdout.write(inv.command ? renderCommandHelp(inv.command) : renderHelp());
    return 0;
  }
  if (inv.command === null) {
    process.stderr.write(renderHelp());
    return 2;
  }

  try {
    switch (inv.command) {
      case "demo": {
        await (await import("./demo")).runDemo();
        return 0;
      }
      case "classify": {
        await runClassify(inv);
        return 0;
      }
      case "recover": {
        const m = await import("./exec/recover");
        console.log(m.renderReport(m.recoveryScenario()));
        return 0;
      }
      case "eval": {
        (await import("./engine/eval")).runEval();
        return 0;
      }
      case "mcp": {
        await (await import("./mcp/server")).startServer();
        return 0; // the server keeps the process alive via stdin; 0 is the clean-shutdown path
      }
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`toffoli: ${e.message}\n`);
      return 2;
    }
    process.stderr.write(`toffoli: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return 1;
  }
}

// ── entrypoint guard ────────────────────────────────────────────────────────────
// The plain `import.meta.url === file://argv[1]` guard used by the repo's script entries breaks
// for an npm-installed bin: argv[1] is the node_modules/.bin symlink while Node resolves the
// module URL through it. Comparing realpaths handles both layouts.
const invokedAsScript = ((): boolean => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return pathToFileURL(realpathSync(arg)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
