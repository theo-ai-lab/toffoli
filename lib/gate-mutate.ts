/**
 * Toffoli — gate falsification. `npm run gate:mutate`.
 *
 * `npm run gate` is the repo's release-blocking artifact. A gate nobody has falsified is a
 * decoration: every check might be passing because the code is right, or because the check cannot
 * fail. This harness settles it empirically — it breaks, one at a time, exactly the properties the
 * gate CLAIMS to guard, and requires the gate to notice.
 *
 * Discipline, so the result means something:
 *
 *   - Each mutation is applied to a COPY of the tree under the OS temp dir (node_modules symlinked
 *     back). The working tree is never mutated in place.
 *   - Each mutation breaks what the gate GUARDS — a runtime-safety or classifier property — never
 *     the check's own plumbing. Deleting a check would "fail the gate" while proving nothing.
 *   - A CONTROL run (the unmutated copy) must PASS first. Without it, a broken scratch tree would
 *     make every mutation look caught.
 *   - Every mutation's anchor text must match EXACTLY ONCE. A mutation that no longer applies is a
 *     hard error, not a silent skip — otherwise refactors quietly retire the falsification.
 *   - The floors are the shipped ones: TOFFOLI_MIN_RECALL / TOFFOLI_MIN_PRECISION are stripped from
 *     the child env so a local override can't mask a survivor.
 *
 * A SURVIVOR (mutation applied, gate still passed) is a real finding: it names a property the gate
 * is documented to protect but does not actually detect. Survivors are printed under their own
 * heading and make this command exit non-zero.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Mutation {
  /** Stable id — `npm run gate:mutate -- --only <name>` runs just this one. */
  name: string;
  /** Repo-relative source file. */
  file: string;
  /** The property the gate claims to guard, in the gate's own terms. */
  guards: string;
  /** Anchor text; must occur EXACTLY once in `file`. */
  find: string;
  /** What it becomes. */
  replace: string;
}

/**
 * The mutation set. Each one is a plausible bad edit — a dropped clause, an inverted branch, a
 * loosened pattern — not vandalism, and each targets a DIFFERENT gate check so a survivor points at
 * exactly one hole.
 */
const MUTATIONS: Mutation[] = [
  {
    name: "policy-drops-llm-assisted-clause",
    file: "lib/runtime/policy.ts",
    guards: "an LLM-judged verdict can never EARN autonomy (SAFETY.md control #10; the judge lowers the ceiling, never raises it)",
    find: `  if (c.llmAssisted && !policy.allowLlmAssisted) {
    return { auto: false, reason: "judge-assisted verdict — confirm required (judge may lower autonomy, never grant it)" };
  }
`,
    replace: "",
  },
  {
    name: "kill-switch-branch-inverted",
    file: "lib/runtime/mode.ts",
    guards: "the kill-switch is ENFORCED at the chokepoint (TOFFOLI_EXECUTE_DISABLED forces dry-run)",
    find: "  if (kill) {\n    return {\n      requested: req,\n      effective: \"dry-run\",",
    replace: "  if (!kill) {\n    return {\n      requested: req,\n      effective: \"dry-run\",",
  },
  {
    name: "journal-confirms-always-true",
    file: "lib/runtime/journal.ts",
    guards: "the anti-fabrication invariant — nothing is REPORTED restored unless the durable journal confirms it (the Replit failure mode)",
    find: "    return this.intended.has(idemKey) && this.map.get(idemKey)?.status === \"done\";",
    replace: "    return true;",
  },
  {
    name: "confirm-token-ignores-plan-contents",
    file: "lib/runtime/safe-executor.ts",
    guards: "the confirm token is BOUND TO THE PLAN — a token approved for a different plan must not authorize this one",
    find: `  const canonical = JSON.stringify({
    steps: plan.steps.map((s) => ({ a: s.forActionId, m: s.compensation.method, k: s.compensation.idempotencyKey, p: s.compensation.params ?? null })),
    escalations: plan.escalations.map((e) => e.forActionId).sort(),
  });`,
    replace: "  const canonical = JSON.stringify({ steps: plan.steps.length });",
  },
  {
    name: "ddl-rule-misses-DROP",
    file: "lib/engine/classify.ts",
    guards: "destructive DDL with no recoverable copy is IRREVERSIBLE (the catastrophic-miss floor)",
    find: "  return /(^|;)\\s*(DROP|TRUNCATE)\\b/i.test(sql);",
    replace: "  return /(^|;)\\s*(TRUNCATE)\\b/i.test(sql);",
  },
  {
    name: "hard-delete-abstains-instead-of-irreversible",
    file: "lib/engine/classify.ts",
    guards: "an ambiguous action fails TOWARD the severe class — IRREVERSIBLE recall floor",
    find: `      return build(action, "IRREVERSIBLE", "delete:no-recoverable-copy", "a hard delete with no recoverable copy cannot be restored", opRef, "REVERSIBLE");`,
    replace: "      return null;",
  },
  {
    name: "classifier-forced-to-irreversible",
    file: "lib/engine/classify.ts",
    guards: "the precision floor — over-escalating everything must not be a way to buy recall",
    find: "export function classifyDeterministic(action: AgentAction): Classification | null {",
    replace: `export function classifyDeterministic(action: AgentAction): Classification | null {
  if (action) return build(action, "IRREVERSIBLE", "mutant:forced", "forced", "mutant");`,
  },
];

// ── harness ────────────────────────────────────────────────────────────────────

interface GateCheck {
  pass: boolean;
  /** The gate's own parenthetical, e.g. "recall=0.83" — a survivor's detail delta is the evidence. */
  detail: string;
}
interface GateRun {
  passed: boolean;
  /** Gate check name → outcome, in the gate's own wording. */
  checks: Map<string, GateCheck>;
  output: string;
}

const CHECK_LINE = /^\s*([✓✗])\s(.+?)(?:\s\s\((.*)\))?$/;

function parseGate(output: string): Map<string, GateCheck> {
  const checks = new Map<string, GateCheck>();
  for (const line of output.split("\n")) {
    const m = CHECK_LINE.exec(line.trimEnd());
    if (m) checks.set(m[2]!.trim(), { pass: m[1] === "✓", detail: m[3] ?? "" });
  }
  return checks;
}

/** Copy the working tree (minus build/VCS/dependency dirs) and symlink node_modules back. */
function makeScratchTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "toffoli-mutate-"));
  const tree = join(dir, "tree");
  const skipTop = new Set(["node_modules", ".git", "dist", "coverage", "traces", "logs"]);
  cpSync(REPO_ROOT, tree, {
    recursive: true,
    filter: (src) => {
      if (src === REPO_ROOT) return true;
      const rel = src.slice(REPO_ROOT.length + 1);
      const top = rel.split("/")[0]!;
      return !skipTop.has(top) && !top.startsWith(".bin-test-") && !top.endsWith(".tgz");
    },
  });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(tree, "node_modules"));
  return tree;
}

function runGate(tree: string): GateRun {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The shipped floors decide, never a local override.
  delete env["TOFFOLI_MIN_RECALL"];
  delete env["TOFFOLI_MIN_PRECISION"];
  let output: string;
  let passed: boolean;
  try {
    output = execFileSync(join(tree, "node_modules/.bin/tsx"), ["lib/gate.ts"], { cwd: tree, env, encoding: "utf8", stdio: "pipe" });
    passed = true;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    output = `${err.stdout ?? ""}${err.stderr ?? ""}` || (err.message ?? "");
    passed = false;
  }
  return { passed, checks: parseGate(output), output };
}

/** Apply one mutation to the scratch tree. The anchor must match exactly once. */
function applyMutation(tree: string, m: Mutation): void {
  const path = join(tree, m.file);
  const before = readFileSync(path, "utf8");
  const occurrences = before.split(m.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `mutation '${m.name}': anchor matched ${occurrences} time(s) in ${m.file}, expected exactly 1.\n` +
        "The source moved out from under the falsification — re-anchor the mutation rather than deleting it.",
    );
  }
  writeFileSync(path, before.replace(m.find, m.replace));
}

function main(): void {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined;
  const selected = only ? MUTATIONS.filter((m) => m.name === only) : MUTATIONS;
  if (only && selected.length === 0) {
    console.error(`no mutation named '${only}'. Known: ${MUTATIONS.map((m) => m.name).join(", ")}`);
    process.exit(2);
  }

  console.log(`\n  TOFFOLI — gate falsification (${selected.length} mutation${selected.length === 1 ? "" : "s"})\n  ${"─".repeat(72)}`);

  // ── control: the unmutated copy must pass, or nothing below means anything ──
  const controlTree = makeScratchTree();
  const control = runGate(controlTree);
  rmSync(dirname(controlTree), { recursive: true, force: true });
  if (!control.passed) {
    console.log("  ✗ CONTROL — the UNMUTATED scratch tree failed the gate. The harness is broken, not the code.\n");
    console.log(control.output);
    process.exit(1);
  }
  console.log(`  ✓ control: unmutated scratch tree PASSES the gate (${control.checks.size} checks)\n`);

  const survivors: Array<{ m: Mutation }> = [];
  for (const m of selected) {
    const tree = makeScratchTree();
    try {
      applyMutation(tree, m);
      const run = runGate(tree);
      const flipped = [...run.checks].filter(([name, c]) => !c.pass && control.checks.get(name)?.pass === true).map(([name]) => name);
      if (run.passed) {
        survivors.push({ m });
        console.log(`  ✗ SURVIVED  ${m.name}`);
        console.log(`              guards: ${m.guards}`);
        // Detail deltas are the evidence for HOW it slipped past — e.g. a floor that still cleared.
        const moved = [...run.checks].filter(([name, c]) => c.detail !== (control.checks.get(name)?.detail ?? c.detail));
        for (const [name, c] of moved) console.log(`              ↳ still ✓ "${name}": ${control.checks.get(name)!.detail} → ${c.detail}`);
        console.log("              the gate passed with this property BROKEN.\n");
      } else {
        console.log(`  ✓ caught    ${m.name}`);
        for (const f of flipped) console.log(`              ↳ ${f}`);
        if (flipped.length === 0) console.log("              ↳ (the gate errored out rather than failing a named check)");
        console.log("");
      }
    } finally {
      rmSync(dirname(tree), { recursive: true, force: true });
    }
  }

  console.log(`  ${"─".repeat(72)}`);
  if (survivors.length > 0) {
    console.log(`  FALSIFICATION FAILED — ${survivors.length} of ${selected.length} mutation(s) SURVIVED:\n`);
    for (const { m } of survivors) console.log(`    · ${m.name} — unguarded: ${m.guards}`);
    console.log("\n  Each survivor is a property the gate is documented to protect and does not detect.\n");
    process.exit(1);
  }
  console.log(`  FALSIFICATION PASSED — all ${selected.length} mutation(s) were caught by the gate.\n`);
}

main();
