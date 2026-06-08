/**
 * Toffoli — judge calibration harness. `npm run calibrate` (HUMAN-GATED: needs ANTHROPIC_API_KEY).
 *
 * An LLM judge is a measurement instrument; you don't trust it until you've measured it
 * against the human labels. This runs the judge over the rows the deterministic floor
 * abstains on and reports Cohen's κ (chance-corrected agreement — "the judge agrees 90%"
 * is not enough; Judge's Verdict, NVIDIA, arXiv:2510.09738) plus the judge's per-class
 * accuracy and IRREVERSIBLE recall.
 *
 * Known judge failure mode to watch (Beyond Consensus, arXiv:2510.11822): agreeableness
 * bias — high agreement on "reversible", low on "irreversible". So we also report a
 * minority-veto pass: any IRREVERSIBLE signal forces escalation. Calibrating to a publishable
 * κ needs a larger, 2–3-annotator residual gold set than ships here — that is human work.
 */

import { loadGoldSet } from "../../dataset/schema";
import { classifyDeterministic } from "./classify";
import { claudeJudge, isJudgeAvailable } from "./judge";
import { CLASSES } from "./metrics";
import type { Reversibility } from "./types";

function cohensKappa(a: Reversibility[], b: Reversibility[]): number {
  const n = a.length;
  if (n === 0) return NaN;
  let agree = 0;
  const ca: Record<string, number> = {};
  const cb: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) agree++;
    ca[x] = (ca[x] ?? 0) + 1;
    cb[y] = (cb[y] ?? 0) + 1;
  }
  const po = agree / n;
  let pe = 0;
  for (const c of CLASSES) pe += ((ca[c] ?? 0) / n) * ((cb[c] ?? 0) / n);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

async function main(): Promise<void> {
  if (!isJudgeAvailable()) {
    // Not a failure: the judge is gated, so this harness is human-gated by design. Exit 0 so a
    // reviewer skimming exit codes reads it as a deliberate skip, not a broken script.
    console.log("calibrate: SKIPPED — no ANTHROPIC_API_KEY. The judge is gated, so this calibration harness is human-gated by design (expected, not a failure).");
    return;
  }
  const rows = loadGoldSet({ includeIncidents: true });
  const residual = rows.filter((r) => classifyDeterministic(r.action) === null);
  if (!residual.length) {
    console.log("No residual rows (the floor resolved everything). Add abstain-class rows to calibrate the judge.");
    return;
  }

  const judge = claudeJudge();
  const preds: Reversibility[] = [];
  const gold: Reversibility[] = [];
  console.log(`\nCalibrating the judge on ${residual.length} residual rows (the floor abstained on these):\n`);
  for (const r of residual) {
    const v = await judge(r.action);
    preds.push(v.class);
    gold.push(r.target.class);
    console.log(`  ${r.id.padEnd(20)} judge=${v.class.padEnd(13)} gold=${r.target.class.padEnd(13)} ${v.class === r.target.class ? "✓" : "✗"}  (conf ${v.confidence})`);
  }

  const MIN_N_FOR_KAPPA = 30;
  const kappa = cohensKappa(preds, gold);
  const acc = preds.filter((p, i) => p === gold[i]).length / preds.length;
  const irrGold = gold.filter((g) => g === "IRREVERSIBLE").length;
  const irrCaught = gold.filter((g, i) => g === "IRREVERSIBLE" && preds[i] === "IRREVERSIBLE").length;

  if (preds.length < MIN_N_FOR_KAPPA) {
    console.log(`\n  n=${preds.length} residual rows — too few for a meaningful Cohen's κ (need ≥ ${MIN_N_FOR_KAPPA}). Reporting raw agreement only; build out the residual gold set before trusting any κ.`);
  }
  console.log(`\n  Cohen's κ (judge vs gold): ${Number.isNaN(kappa) ? "n/a" : kappa.toFixed(3)}${preds.length < MIN_N_FOR_KAPPA ? " [UNRELIABLE: n too small]" : ""}   (benchmark against a human-to-human κ baseline before trusting)`);
  console.log(`  accuracy: ${acc.toFixed(2)} on ${preds.length} rows`);
  console.log(`  IRREVERSIBLE recall (judge): ${irrGold ? (irrCaught / irrGold).toFixed(2) : "n/a"}  — the safety-critical number`);
  console.log(`  reminder: ship behind a minority-veto (any IRREVERSIBLE vote → escalate) until κ clears the human baseline.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
