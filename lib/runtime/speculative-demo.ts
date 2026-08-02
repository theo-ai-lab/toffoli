/**
 * Toffoli — the reversibility-gated SPECULATIVE EXECUTION demo. `npm run speculate`.
 *
 * Runs the fixed scenario through the gate and shows the whole story end-to-end on real sandbox state:
 *   1. A real SPECULATE → COMMIT (a recoverable delete / an under-cap charge fired optimistically and
 *      kept once the slow oracle+policy agreed).
 *   2. A real SPECULATE → ROLLBACK (an over-cap charge fired optimistically, then REJECTED by the
 *      policy on a dimension reversibility can't see — losslessly undone through the safety floor and
 *      verified back to the pre-fire baseline).
 *   3. IRREVERSIBLE NEVER SPECULATES (external sends are provably un-undoable → escalated, never fired;
 *      the outbox stays empty).
 *   4. The cascade-telemetry slice + the one-line measured sentence.
 *   5. The acceptance-vs-restitution-cost CURVE (a sweep over the operating eligibility set).
 *   6. The CALIBRATION: a Wilson lower bound, Bonferroni-corrected — never a magic constant.
 *   7. The KILL-SWITCH: under a freeze, NOTHING is fired (speculation needs the right to fire AND roll back).
 *
 * Deterministic and offline (no key, no network). The only mutations are to the in-memory sandbox.
 */

import { buildSpeculativeScenario, scenarioPolicy } from "./speculative-scenario";
import { speculativeExecute, defaultPermissionCheck, renderTelemetrySentence, type SpeculativeOutcome } from "./speculative-gate";
import { speculationCurve, calibrateSpeculation, type AcceptanceObservation } from "./speculative-calibrate";
import { KILL_SWITCH_ENV } from "./mode";

const clock = () => "2026-06-19T00:00:00Z";
const sandboxEnv = {} as NodeJS.ProcessEnv;
const check = defaultPermissionCheck({ policy: scenarioPolicy, clock });

const MARK: Record<SpeculativeOutcome["disposition"], string> = {
  "committed-speculative": "✓ COMMIT  ",
  "rolled-back": "↺ ROLLBACK",
  "ran-checked": "· ran     ",
  blocked: "✗ blocked ",
  "ran-nullipotent": "· read    ",
  escalated: "⚠ ESCALATE",
  "plan-only": "▢ plan    ",
};

function row(o: SpeculativeOutcome): string {
  const spec = o.speculated ? "[spec]" : "      ";
  const loss = o.rollback ? `  lossless=${o.rollback.lossless}` : "";
  return `    ${MARK[o.disposition] ?? o.disposition}  ${spec} ${o.actionId.padEnd(18)} ${String(o.class).padEnd(13)} ${o.reason}${loss}`;
}

async function main(): Promise<void> {
  console.log(`  ${"=".repeat(94)}`);
  console.log("  TOFFOLI — REVERSIBILITY-GATED SPECULATIVE EXECUTION  (speculate only what you can provably undo)");
  console.log(`  ${"=".repeat(94)}`);

  // ── 1–3 · run the gate on the fixed scenario ──
  const { world, ops } = buildSpeculativeScenario();
  const report = await speculativeExecute(ops, world, { permissionCheck: check, env: sandboxEnv, clock, runId: "speculate-demo", caller: "demo" });
  for (const o of report.outcomes) console.log(row(o));

  const after = world.snapshot();
  console.log(`  ${"-".repeat(94)}`);
  console.log(`  speculation acceptance rate: ${(report.speculationAcceptanceRate * 100).toFixed(1)}%  (optimistic fires the oracle+policy permitted)`);
  console.log(`  mis-speculation restitution cost: ${report.misSpeculationRestitutionCost} compensation step(s) executed to roll back rejected guesses`);
  console.log(`  IRREVERSIBLE actions fired on a guess: 0  (outbox after run: ${after.outbox.length} sends — every external send was escalated, never speculated)`);
  const rolledBack = report.outcomes.filter((o) => o.disposition === "rolled-back");
  console.log(`  every rollback restored the pre-fire baseline (lossless): ${rolledBack.every((o) => o.rollback?.lossless) ? "YES" : "NO"}  (${rolledBack.length} mis-speculation(s))`);
  console.log(`  escalated to a human (durable, never auto-undone): ${report.escalations.length}`);

  // ── 4 · the cascade-telemetry slice + the measured sentence ──
  const t = report.telemetry;
  console.log(`\n  CASCADE TELEMETRY (boundary: ${t.boundary})`);
  console.log(`    regime=${t.regime}  locus=${t.locus}  n=${t.n}`);
  console.log(`    alpha (cheap fast path resolved losslessly) ............ ${(t.alpha * 100).toFixed(1)}%`);
  console.log(`    disagreementRate (both tiers ran, verdicts differed) .. ${(t.disagreementRate * 100).toFixed(1)}%   (over ${t.comparable} comparable inputs)`);
  console.log(`    losslessViolations (must be 0) ........................ ${t.losslessViolations}`);
  console.log(`    breakdown: ${Object.entries(t.counts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log(`\n  MEASURED: ${renderTelemetrySentence(t)}`);

  // ── 5 · the acceptance-vs-restitution-cost curve (parameter sweep over a FIXED scenario) ──
  const curve = await speculationCurve(
    buildSpeculativeScenario,
    [
      { label: "speculate nothing      ", speculateClasses: [] },
      { label: "REVERSIBLE only        ", speculateClasses: ["REVERSIBLE"] },
      { label: "REVERSIBLE+COMPENSABLE ", speculateClasses: ["REVERSIBLE", "COMPENSABLE"] },
    ],
    { permissionCheck: check, env: sandboxEnv, clock },
  );
  console.log("\n  CURVE — speculation acceptance rate vs mis-speculation restitution cost (FIXED 12-action scenario)");
  console.log("    operating policy          accept-rate   restitution-cost   alpha    disagree   lossless-viol");
  for (const p of curve) {
    const acc = Number.isNaN(p.speculationAcceptanceRate) ? "  n/a " : `${(p.speculationAcceptanceRate * 100).toFixed(1)}%`.padStart(6);
    console.log(`    ${p.label}     ${acc}        ${String(p.misSpeculationRestitutionCost).padStart(3)}            ${(p.alpha * 100).toFixed(0)}%      ${(p.disagreementRate * 100).toFixed(1)}%        ${p.losslessViolations}`);
  }

  // ── 6 · calibration (methodology, not a headline number) ──
  const observations: AcceptanceObservation[] = report.outcomes
    .filter((o) => o.speculated)
    .map((o) => ({ class: o.class as "REVERSIBLE" | "COMPENSABLE", permitted: o.disposition === "committed-speculative" }));
  const calib = calibrateSpeculation(observations, { latencySaved: 5, rollbackCost: 1 });
  console.log("\n  CALIBRATION (Wilson lower bound, Bonferroni-corrected — never a magic constant)");
  console.log(`    ${calib.method}`);
  for (const c of calib.perClass) {
    console.log(`    ${c.class.padEnd(12)} n=${c.nObs} accept̂=${c.acceptHat.toFixed(2)} wilsonLower=${c.wilsonLower.toFixed(2)} → ${c.recommend ? "speculate" : "DON'T speculate (lower bound below break-even at this n)"}`);
  }
  console.log(`    calibrated eligibility set: [${calib.speculateClasses.join(", ") || "(none — too little data to clear the bar)"}]`);

  // ── 7 · kill-switch: nothing fires ──
  const frozen = buildSpeculativeScenario();
  const frozenReport = await speculativeExecute(frozen.ops, frozen.world, { permissionCheck: defaultPermissionCheck({ policy: scenarioPolicy, env: { [KILL_SWITCH_ENV]: "1" } as NodeJS.ProcessEnv, clock }), env: { [KILL_SWITCH_ENV]: "1" } as NodeJS.ProcessEnv, clock });
  const firedUnderFreeze = frozenReport.outcomes.filter((o) => o.fired).length;
  console.log(`\n  KILL-SWITCH (${KILL_SWITCH_ENV}=1): actions fired = ${firedUnderFreeze} (all plan-only); sandbox unchanged = ${JSON.stringify(frozen.world.snapshot()) === JSON.stringify(buildSpeculativeScenario().world.snapshot())}`);
  console.log(`  ${"=".repeat(94)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
