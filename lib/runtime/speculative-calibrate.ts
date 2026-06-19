/**
 * Toffoli — speculation calibration + the acceptance-vs-restitution-cost CURVE.
 *
 * The gate's safety envelope (speculate iff REVERSIBLE/COMPENSABLE) is PROVABLE and needs no tuning.
 * But *whether speculation pays off* is an economic question, and the honest way to answer it is to
 * CALIBRATE — never a magic constant:
 *
 *   1. BREAK-EVEN, derived not guessed. Speculation pays off when the expected latency saved on an
 *      accepted guess outweighs the expected cost of repairing a rejected one. With per-action costs
 *      (operator-supplied), the break-even acceptance rate is τ = rollbackCost / (latencySaved +
 *      rollbackCost). A class is worth speculating iff its TRUE acceptance rate exceeds τ.
 *
 *   2. A LOWER BOUND, not a point estimate. We never speculate on a flattering point estimate of the
 *      acceptance rate — we require a one-sided WILSON lower confidence bound (the same interval the
 *      eval uses; a Wald/CLT interval badly understates uncertainty at small n) to clear τ. At small n
 *      the bound is wide, so the calibration is deliberately CONSERVATIVE (it may recommend speculating
 *      nothing) rather than over-claim. This is the methodology; it is not a published guarantee.
 *
 *   3. MULTIPLICITY-CORRECTED. Calibrating m classes at once is m simultaneous decisions, so the
 *      per-class confidence is BONFERRONI-corrected (one-sided α/m) to hold the family-wise error rate
 *      at α. A number tuned across several classes and reported as if it were one is slop; this avoids it.
 *
 * The CURVE is a parameter sweep over a FIXED action scenario (NOT an extrapolation over gold-set size,
 * which is indefensible at small n): for each operating eligibility set it reports the realized
 * acceptance rate and the realized restitution cost, tracing the efficiency/repair-cost frontier.
 *
 * Zero model spend. Zero runtime dependencies (reuses the eval's Wilson interval + node built-ins).
 */

import type { Reversibility } from "../engine/types";
import { wilson } from "../engine/metrics";
import type { RecoveryWorld } from "../exec/world";
import { speculativeExecute, type SpeculativeGateOptions, type SpeculativeOp } from "./speculative-gate";

// ── calibration ───────────────────────────────────────────────────────────────────────────────────

/** A single observed speculation outcome (from a held-out / prior scenario): class + whether it was permitted. */
export interface AcceptanceObservation {
  class: Reversibility;
  permitted: boolean;
}

/** Operator-supplied costs. UNITS ARE THE OPERATOR'S — they cancel in the break-even ratio τ. */
export interface SpeculationCostModel {
  /** What an accepted guess SAVES (hidden oracle latency / parallelism). */
  latencySaved: number;
  /** What a rejected guess COSTS to repair (the rollback / compensation work). */
  rollbackCost: number;
}

export interface ClassCalibration {
  class: Reversibility;
  nObs: number;
  accepted: number;
  /** Point estimate of acceptance — informational ONLY; the decision uses `wilsonLower`. */
  acceptHat: number;
  /** One-sided Wilson LOWER confidence bound on acceptance, Bonferroni-corrected across the calibrated classes. */
  wilsonLower: number;
  /** Recommend speculating this class iff there is data AND its Wilson lower bound clears the break-even τ. */
  recommend: boolean;
}

export interface SpeculationCalibration {
  /** Break-even acceptance rate τ = rollbackCost / (latencySaved + rollbackCost). Speculate iff lowerBound ≥ τ. */
  breakEven: number;
  /** The family-wise error rate the calibration controls (default 0.05). */
  familyAlpha: number;
  /** The Bonferroni-corrected per-class one-sided α (familyAlpha / m, m = classes with data). */
  perClassAlpha: number;
  /** The classes whose Wilson lower bound clears τ — the calibrated operating eligibility set. */
  speculateClasses: Reversibility[];
  perClass: ClassCalibration[];
  /** Plain-language method note, printed so the threshold is never mistaken for a magic constant. */
  method: string;
}

/** The only classes a reversibility-gated speculator may ever fire on (NULLIPOTENT/IRREVERSIBLE/ABSTAIN are out by floor). */
const SPECULATABLE: readonly Reversibility[] = ["REVERSIBLE", "COMPENSABLE"] as const;

export interface CalibrateOptions {
  /** Family-wise error rate to control across the calibrated classes. Default 0.05. */
  familyAlpha?: number;
}

/**
 * Calibrate which speculatable classes are worth firing on, from observed acceptance data and a cost
 * model. Conservative by construction (Wilson lower bound, Bonferroni-corrected) — at small n it
 * recommends LESS speculation, never more. Returns the calibrated eligibility set + the full working.
 */
export function calibrateSpeculation(
  observations: AcceptanceObservation[],
  cost: SpeculationCostModel,
  opts: CalibrateOptions = {},
): SpeculationCalibration {
  const familyAlpha = opts.familyAlpha ?? 0.05;
  const denom = cost.latencySaved + cost.rollbackCost;
  const breakEven = denom <= 0 ? 1 : cost.rollbackCost / denom;

  // Multiplicity: m = the number of speculatable classes we actually have data for.
  const withData = SPECULATABLE.filter((c) => observations.some((o) => o.class === c));
  const m = Math.max(withData.length, 1);
  const perClassAlpha = familyAlpha / m;
  // One-sided lower bound at level (1 - perClassAlpha): the Wilson lower endpoint with critical z.
  const z = normalQuantile(1 - perClassAlpha);

  const perClass: ClassCalibration[] = SPECULATABLE.map((cls) => {
    const obs = observations.filter((o) => o.class === cls);
    const nObs = obs.length;
    const accepted = obs.filter((o) => o.permitted).length;
    const acceptHat = nObs === 0 ? 0 : accepted / nObs;
    const interval = wilson(accepted, nObs, z);
    const wilsonLower = interval ? interval.lo : 0;
    return { class: cls, nObs, accepted, acceptHat, wilsonLower, recommend: nObs > 0 && wilsonLower >= breakEven };
  });

  return {
    breakEven,
    familyAlpha,
    perClassAlpha,
    speculateClasses: perClass.filter((c) => c.recommend).map((c) => c.class),
    perClass,
    method: `break-even τ=${breakEven.toFixed(3)} (rollbackCost/(latencySaved+rollbackCost)); speculate a class iff its one-sided Wilson lower bound (Bonferroni α/m, m=${m}, z=${z.toFixed(3)}) ≥ τ. Conservative at small n by design.`,
  };
}

// ── the acceptance-vs-restitution-cost curve (a sweep over a FIXED scenario) ──────────────────────

export interface OperatingPolicy {
  label: string;
  speculateClasses: Reversibility[];
}

export interface CurvePoint {
  label: string;
  speculateClasses: Reversibility[];
  /** Fraction of optimistic fires the authoritative tier permitted (NaN if this policy fired none). */
  speculationAcceptanceRate: number;
  /** Total compensation steps executed to roll back mis-speculations under this policy. */
  misSpeculationRestitutionCost: number;
  /** The cheap fast path's lossless-resolve fraction under this policy. */
  alpha: number;
  /** The classifier-vs-authority disagreement rate (stable across policies; a property of the scenario). */
  disagreementRate: number;
  /** Must be 0 for every policy — the safety-envelope invariant, measured. */
  losslessViolations: number;
  n: number;
}

/**
 * Trace the efficiency/repair-cost frontier by sweeping the operating eligibility set over a FIXED
 * scenario. `buildScenario` MUST return a fresh world + ops each call (the gate mutates the world), so
 * every policy is measured on an identical starting state — a parameter sweep on a fixed set, never an
 * extrapolation over set size. As the eligible set widens, more guesses fire: acceptance typically
 * falls and restitution cost rises. The disagreement rate is invariant (it is the classifier's
 * intrinsic optimism vs the authority), and lossless violations stay 0 throughout.
 */
export async function speculationCurve<W extends RecoveryWorld>(
  buildScenario: () => { world: W; ops: SpeculativeOp<W>[] },
  policies: OperatingPolicy[],
  opts: SpeculativeGateOptions<W> = {},
): Promise<CurvePoint[]> {
  const points: CurvePoint[] = [];
  for (const policy of policies) {
    const { world, ops } = buildScenario();
    const report = await speculativeExecute(ops, world, { ...opts, speculateClasses: policy.speculateClasses });
    points.push({
      label: policy.label,
      speculateClasses: policy.speculateClasses,
      speculationAcceptanceRate: report.speculationAcceptanceRate,
      misSpeculationRestitutionCost: report.misSpeculationRestitutionCost,
      alpha: report.telemetry.alpha,
      disagreementRate: report.telemetry.disagreementRate,
      losslessViolations: report.telemetry.losslessViolations,
      n: report.telemetry.n,
    });
  }
  return points;
}

// ── inverse standard-normal CDF (for an arbitrary-confidence one-sided Wilson z) ──────────────────

/**
 * Peter Acklam's rational approximation to the inverse standard-normal CDF (|abs err| < 1.15e-9 over
 * the open interval). Deterministic; no dependency. Used to turn a Bonferroni-corrected confidence
 * level into the Wilson critical value `z`.
 */
export function normalQuantile(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  const a: readonly [number, number, number, number, number, number] = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0];
  const b: readonly [number, number, number, number, number] = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c: readonly [number, number, number, number, number, number] = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d: readonly [number, number, number, number] = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
