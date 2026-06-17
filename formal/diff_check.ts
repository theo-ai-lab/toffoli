/**
 * formal/diff_check.ts — faithfulness of the Lean model to the TypeScript bytes.
 *
 * The Lean proof (formal/ToffoliFormal.lean) proves soundness of `classifyPlus`, an
 * operational model of `classifyDeterministic`. This script closes the model-vs-bytes gap:
 * it enumerates the FULL finite Signals space, and for each point
 *   (1) constructs the corresponding real `AgentAction`,
 *   (2) runs the REAL `classifyDeterministic` from lib/engine/classify.ts, mapping its
 *       abstain (`null`) to IRREVERSIBLE — exactly the C⁺ fail-safe join, and
 *   (3) asserts the result EXACTLY equals the class the verified Lean `classifyPlus`
 *       assigns to that point (read from the Lean executable's JSON export).
 *
 * If every point agrees, the Lean model is a faithful abstraction of the TS classifier at
 * the resolved-op level, so the mechanized soundness theorem transfers to the real bytes
 * (modulo op-resolution, which is explicitly out of scope — see formal/README.md).
 *
 * Run: node_modules/.bin/tsx formal/diff_check.ts
 */

import { execFileSync } from "node:child_process";
import * as os from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDeterministic } from "../lib/engine/classify";
import type { ActionOp, AgentAction, ResourceRef, Reversibility } from "../lib/engine/types";

type Tri = "yes" | "no" | "unknown";

interface Sig {
  op: ActionOp;
  committed: boolean;
  destructiveDdl: boolean;
  neverRecoverable: boolean;
  openTxn: boolean;
  recoverable: Tri;
  externalized: Tri;
  priorState: boolean;
}

const OPS: ActionOp[] = [
  "read", "create", "update", "delete", "append",
  "send", "pay", "publish", "deploy", "execute", "custom",
];
const BOOLS = [false, true] as const;
const TRIS: Tri[] = ["yes", "no", "unknown"];

/** The full finite Signals space, in the SAME fixed field order as Main.lean. */
function* enumerate(): Generator<Sig> {
  for (const op of OPS)
    for (const committed of BOOLS)
      for (const destructiveDdl of BOOLS)
        for (const neverRecoverable of BOOLS)
          for (const openTxn of BOOLS)
            for (const recoverable of TRIS)
              for (const externalized of TRIS)
                for (const priorState of BOOLS)
                  yield {
                    op, committed, destructiveDdl, neverRecoverable,
                    openTxn, recoverable, externalized, priorState,
                  };
}

/**
 * Build the real AgentAction a Signals point denotes, exercising exactly the branches
 * `classifyDeterministic` reads:
 *   - op is DECLARED (resolveOp returns it directly — op-resolution is assumed correct / out of scope);
 *   - destructiveDdl/neverRecoverable are encoded as the literal SQL the DDL/never-recoverable
 *     regexes scan (DROP DATABASE = never-recoverable; DROP TABLE = ordinary destructive DDL);
 *   - openTxn is `transaction: "open"`;
 *   - recoverable/externalized are target booleans (omitted when `unknown`);
 *   - priorState present iff the prior value was captured.
 * A target with no signals at all is omitted entirely (observationally identical to a
 * present-but-empty target under `t?.field`).
 */
function buildAction(s: Sig): AgentAction {
  const params: Record<string, unknown> = {};
  if (s.destructiveDdl) {
    params["sql"] = s.neverRecoverable ? "DROP DATABASE app" : "DROP TABLE app.users";
  }
  if (s.openTxn) params["transaction"] = "open";

  const target: ResourceRef = { kind: "resource" };
  let hasTarget = false;
  if (s.recoverable === "yes") { target.recoverable = true; hasTarget = true; }
  else if (s.recoverable === "no") { target.recoverable = false; hasTarget = true; }
  if (s.externalized === "yes") { target.externalized = true; hasTarget = true; }
  else if (s.externalized === "no") { target.externalized = false; hasTarget = true; }
  if (s.priorState) { target.priorState = { v: 1 }; hasTarget = true; }

  return {
    id: "a1",
    tool: "declared",
    op: s.op,
    committed: s.committed,
    ...(Object.keys(params).length ? { params } : {}),
    ...(hasTarget ? { target } : {}),
  };
}

/** The real classifier's verdict, with abstain (`null`) joined to ⊤ — i.e. C⁺. */
function tsClassPlus(s: Sig): Reversibility {
  const c = classifyDeterministic(buildAction(s));
  return c === null ? "IRREVERSIBLE" : c.class;
}

/** Canonical key over the signal fields, identical on both sides. */
function key(s: Sig): string {
  return JSON.stringify([
    s.op, s.committed, s.destructiveDdl, s.neverRecoverable,
    s.openTxn, s.recoverable, s.externalized, s.priorState,
  ]);
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url)); // formal/
  const elanPath = `${os.homedir()}/.elan/bin:${process.env["PATH"] ?? ""}`;

  // 1. Read the verified Lean decision table (builds on demand).
  let raw: string;
  try {
    raw = execFileSync("lake", ["exe", "export_table"], {
      cwd: here,
      env: { ...process.env, PATH: elanPath },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    console.error("diff_check: failed to run `lake exe export_table` (is Lean on PATH?)");
    console.error((e as Error).message);
    process.exit(2);
  }

  const leanRows = JSON.parse(raw) as Array<Sig & { class: Reversibility }>;
  const leanMap = new Map<string, Reversibility>();
  for (const r of leanRows) leanMap.set(key(r), r.class);

  // 2. Enumerate the same space; compare REAL TS classifier (C⁺) vs Lean classifyPlus.
  let checked = 0;
  let mismatches = 0;
  const examples: string[] = [];
  for (const s of enumerate()) {
    checked++;
    const ts = tsClassPlus(s);
    const lean = leanMap.get(key(s));
    if (lean === undefined) {
      mismatches++;
      if (examples.length < 25) examples.push(`MISSING Lean row for ${key(s)}`);
      continue;
    }
    if (ts !== lean) {
      mismatches++;
      if (examples.length < 25) examples.push(`${key(s)}  TS(C⁺)=${ts}  LEAN=${lean}`);
    }
  }

  const sizeMatch = leanMap.size === checked;
  console.log(`\n  TOFFOLI — Lean↔TS faithfulness (diff_check)`);
  console.log(`  ${"─".repeat(62)}`);
  console.log(`  signals enumerated (TS):    ${checked}`);
  console.log(`  signals exported (Lean):    ${leanMap.size}`);
  console.log(`  space-size agreement:       ${sizeMatch ? "ok" : "MISMATCH"}`);
  console.log(`  per-point class mismatches: ${mismatches}`);
  if (examples.length) {
    console.log(`  ${"─".repeat(62)}`);
    for (const ex of examples) console.log(`  ✗ ${ex}`);
  }
  console.log(`  ${"─".repeat(62)}`);
  if (!sizeMatch || mismatches > 0) {
    console.log(`  DIFF FAILED — the Lean model does NOT match the TS bytes.\n`);
    process.exit(1);
  }
  console.log(`  DIFF OK — real classifyDeterministic (abstain↦⊤) == verified classifyPlus`);
  console.log(`  on all ${checked} points of the Signals space.\n`);
}

main();
