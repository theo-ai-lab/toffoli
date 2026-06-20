/**
 * Toffoli — the COUNTEREXAMPLE-SEARCH demo. `npm run search`.
 *
 * Runs the adversarial no-under-call sweep and prints BOTH halves of the honest result:
 *   1. the fair adversarial sweep (the empirical complement to the Lean proof) — 0 under-calls; and
 *   2. the DISCLOSED GAPS in the op-resolution layer the proof assumes correct — reported, not masked.
 *
 * Deterministic and offline (seeded fast-check; no key, no network). Nothing is mutated.
 */

import { searchCounterexamples, reproduceKnownGaps } from "./counterexample-search";

const count = Number(process.env["SEARCH_COUNT"] ?? 2000);
const r = searchCounterexamples({ count });

console.log(`  ${"=".repeat(78)}`);
console.log("  TOFFOLI — ADVERSARIAL COUNTEREXAMPLE SEARCH (no classifier under-call)");
console.log(`  ${"=".repeat(78)}`);
console.log(`  fair adversarial cases: ${r.casesRun}   (seed 0x${r.seed.toString(16)})`);
console.log(`  true-class coverage: ${Object.entries(r.classesSeen).map(([k, v]) => `${k}=${v}`).join("  ")}`);
console.log(`  safe over-calls: ${r.strictOverCalls}   abstentions (→IRREVERSIBLE lens): ${r.abstentions}`);
console.log(`  attack surfaces probed: ${Object.keys(r.profilesSeen).length}`);
console.log(`  ${"-".repeat(78)}`);
console.log(`  UNDER-CALLS FOUND (classifier resolved a surface SAFER than the truth): ${r.underCalls.length}`);
for (const u of r.underCalls) console.log(`    ✗ ${u.rationale}`);
if (r.underCalls.length === 0) {
  console.log("    ✓ none — the no-under-call property holds across the fair sweep (the proof's domain).");
}

console.log(`  ${"-".repeat(78)}`);
const gaps = reproduceKnownGaps();
console.log(`  DISCLOSED GAPS in op-resolution (the proof's undischarged assumption): ${gaps.length}`);
console.log("  These are GENUINE under-calls, reported — not folded into the headline sweep.");
for (const g of gaps) console.log(`    ⚠ ${g.rationale}`);
console.log(`  ${"=".repeat(78)}`);

// A clean exit code: the FAIR sweep must be clean; the disclosed gaps are tracked separately.
if (r.underCalls.length > 0) process.exitCode = 1;
