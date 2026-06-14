/**
 * Toffoli — the eval CLI. `npm run eval`.
 *
 * The always-runnable, reproducible number: the deterministic floor scored per-class
 * over the labeled gold set. This measures the CLASSIFIER's accuracy on fixtures — it is
 * NOT a claim about how often real agents take irreversible actions (that prevalence
 * number is gated to `self-run` provenance and is pending; see the README).
 */

import { loadGoldSet } from "../../dataset/schema";
import { generateLabeledSet, split } from "../../dataset/generate";
import { evaluate, type EvalReport } from "./metrics";
import { bootstrapRecallCI } from "./bootstrap";
import { isReal } from "./types";

function pct(x: number | null): string {
  return x === null ? "   —  " : x.toFixed(2).padStart(6);
}

function bar(): string {
  return "─".repeat(72);
}

function render(report: EvalReport, label: string): void {
  console.log(`\n${bar()}\n  TOFFOLI — reversibility classifier, deterministic floor\n  gold set: ${label} (n=${report.n})\n${bar()}`);
  console.log("  class           support   precision   recall    tp  fp  fn");
  for (const m of report.perClass) {
    console.log(
      `  ${m.cls.padEnd(14)} ${String(m.support).padStart(6)}     ${pct(m.precision)}    ${pct(m.recall)}   ${String(m.tp).padStart(3)} ${String(m.fp).padStart(3)} ${String(m.fn).padStart(3)}`,
    );
  }
  console.log(bar());

  const irr = report.perClass.find((m) => m.cls === "IRREVERSIBLE");
  const ci = report.irreversibleRecallCI;
  const ciStr = ci ? ` (95% CI ${ci.lo.toFixed(2)}–${ci.hi.toFixed(2)}, Wilson)` : "";
  console.log(`  HEADLINE  IRREVERSIBLE recall: ${pct(irr?.recall ?? null).trim()}${ciStr}, n=${irr?.support ?? 0}`);
  console.log(`            IRREVERSIBLE precision: ${pct(irr?.precision ?? null).trim()}  (recall is never reported alone — escalating everything games it)`);
  console.log(`  SAFETY    catastrophic misses (irreversible called auto-undoable): ${report.dangerousMisses}   ${report.dangerousMisses === 0 ? "✓ none" : "✗ REGRESSION"}`);
  console.log(`            committed missed escalations (irreversible called recoverable): ${report.missedEscalations}   ${report.missedEscalations === 0 ? "✓ none — the floor never confidently under-calls" : ""}`);
  console.log(`  ABSTAIN   rules abstained → judge (rules-alone lens scores these as a miss; the product escalates them): ${report.abstained}`);
  console.log(`  COMMITTED accuracy where the floor committed: ${report.committedCorrect}/${report.committedTotal}`);
  console.log(`  COST      Total Classification Cost (PRODUCT lens: abstain→fail-safe IRREVERSIBLE; C[under-call irr]=100): ${report.totalCost}`);
  console.log(`${bar()}\n  Reproduce: npm test (engine) · npm run eval (this table). Numbers are classifier`);
  console.log(`  accuracy on fixtures, NOT real-world prevalence (gated to self-run; pending).\n`);
}

const all = loadGoldSet({ includeIncidents: true });
render(evaluate(all), "synthetic-seed + documented-incident");

// The deterministic floor's accuracy holds on real documented incidents alone, too.
const realOnly = all.filter(isReal);
if (realOnly.length) render(evaluate(realOnly), "documented-incident only (real-world cases)");

// At-scale: a controlled SYNTHETIC distribution (400 cases, ~22% signal-omitted ambiguous), with a
// held-out split and a percentile-bootstrap CI — statistical power the tiny hand-labeled set lacks.
// This measures the classifier on a known distribution, NOT real-world prevalence.
const generated = generateLabeledSet({ n: 400, seed: 1234 });
const { heldOut } = split(generated, 7);
const heldReport = evaluate(heldOut);
const ci = bootstrapRecallCI(heldOut, { resamples: 2000, seed: 99 });
const irr = heldReport.perClass.find((m) => m.cls === "IRREVERSIBLE");
console.log(`${bar()}\n  AT-SCALE (synthetic, controlled distribution — NOT prevalence)\n${bar()}`);
console.log(`  generated held-out n=${heldOut.length} · IRREVERSIBLE support=${irr?.support ?? 0}`);
console.log(`  IRREVERSIBLE recall: ${(irr?.recall ?? 0).toFixed(2)}  (bootstrap 95% CI ${ci.lo.toFixed(2)}–${ci.hi.toFixed(2)}, n=${ci.n}, ${ci.resamples} resamples)`);
console.log(`  catastrophic misses: ${heldReport.dangerousMisses}   committed missed-escalations: ${heldReport.missedEscalations}`);
console.log(`  ↑ the larger held-out set tightens the interval the hand-labeled n=24 set can't; the small`);
console.log(`    set stays the harder, honest headline. Real-distribution numbers need real traces (pending).\n${bar()}\n`);
