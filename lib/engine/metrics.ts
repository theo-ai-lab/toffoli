/**
 * Toffoli — per-class evaluation metrics.
 *
 * Scores the DETERMINISTIC floor against the labeled gold set. Reports per-class
 * precision/recall (never one flattering accuracy number) and the headline numbers:
 *
 *   1. IRREVERSIBLE recall — how often the rules catch the costly class — with a
 *      Wilson 95% CI (NOT a Wald/CLT interval, which badly understates uncertainty
 *      at small n; Bowyer/Aitchison/Ivanova, arXiv:2503.01747).
 *   2. dangerousMisses — truly IRREVERSIBLE actions the floor called auto-undoable
 *      (NULLIPOTENT/REVERSIBLE). This is the number that must be zero.
 *   3. Total Classification Cost — a cost-sensitive aggregate where mislabeling an
 *      irreversible action as recoverable costs 100× an over-escalation (Lombardo
 *      et al., arXiv:2510.22016). The ratio is a product decision, not a constant.
 *
 * Recall is never reported alone — it is trivially gamed by escalating everything — so
 * IRREVERSIBLE precision and the escalation/abstention counts travel with it.
 *
 * Abstention is honest: a row the floor abstains on counts as a MISS (FN) for its true
 * class — never a wrong guess (no FP), so abstaining can't inflate precision. The product
 * escalates abstentions to a human (restitute.ts); the per-class numbers score the rules
 * alone, while Total Classification Cost applies the product fail-safe (abstain→IRREVERSIBLE).
 *
 * The provenance firewall is enforced by the CALLER (see lib/engine/types.ts).
 */

import { classifyDeterministic } from "./classify";
import type { GroundTruthSample, Reversibility } from "./types";
import { REVERSIBILITY_ORDER } from "./types";

export const CLASSES: readonly Reversibility[] = REVERSIBILITY_ORDER;

export interface ClassMetric {
  cls: Reversibility;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  support: number;
}

export interface Interval {
  lo: number;
  hi: number;
}

export interface EvalReport {
  perClass: ClassMetric[];
  n: number;
  abstained: number;
  /** Truly-IRREVERSIBLE actions the floor COMMITTED to any recoverable class (would not have escalated). Excludes abstentions. */
  missedEscalations: number;
  /** The catastrophic subset of missedEscalations: irreversible called auto-undoable (NULLIPOTENT/REVERSIBLE). Must be 0. */
  dangerousMisses: number;
  committedCorrect: number;
  committedTotal: number;
  /** Wilson 95% CI on IRREVERSIBLE recall (the headline). Null when there are no IRREVERSIBLE positives. */
  irreversibleRecallCI: Interval | null;
  /** Cost-sensitive aggregate (product lens: abstentions apply the fail-safe → IRREVERSIBLE). */
  totalCost: number;
}

const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);
const idx = (c: Reversibility): number => REVERSIBILITY_ORDER.indexOf(c);

/** Wilson score interval for a binomial proportion. */
export function wilson(success: number, n: number, z = 1.96): Interval | null {
  if (n === 0) return null;
  const p = success / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - margin), hi: Math.min(1, center + margin) };
}

/**
 * Cost of predicting `pred` when the truth is `truth`.
 *  - correct → 0
 *  - under-call (claimed safer than reality): catastrophic when the truth is IRREVERSIBLE (100),
 *    else 10 — you'd attempt an undo that can't fully work.
 *  - over-call (claimed more severe than reality): cheap human toil, 1 per severity level.
 */
export function classificationCost(pred: Reversibility, truth: Reversibility): number {
  const p = idx(pred);
  const t = idx(truth);
  if (p === t) return 0;
  if (p < t) return truth === "IRREVERSIBLE" ? 100 : 10;
  return p - t;
}

export function evaluate(rows: GroundTruthSample[]): EvalReport {
  const tally = Object.fromEntries(
    CLASSES.map((c) => [c, { tp: 0, fp: 0, fn: 0, support: 0 }]),
  ) as Record<Reversibility, { tp: number; fp: number; fn: number; support: number }>;

  let abstained = 0;
  let missedEscalations = 0;
  let dangerousMisses = 0;
  let committedCorrect = 0;
  let committedTotal = 0;
  let totalCost = 0;

  for (const row of rows) {
    const truth = row.target.class;
    tally[truth].support++;

    const predicted = classifyDeterministic(row.action);

    if (!predicted) {
      // Rules-alone lens: abstention is a miss for the true class, no false positive.
      tally[truth].fn++;
      abstained++;
      // Cost lens: the product fail-safe escalates an abstention to IRREVERSIBLE.
      totalCost += classificationCost("IRREVERSIBLE", truth);
      continue;
    }

    const pred = predicted.class;
    totalCost += classificationCost(pred, truth);
    committedTotal++;
    if (pred === truth) {
      committedCorrect++;
      tally[truth].tp++;
    } else {
      tally[pred].fp++;
      tally[truth].fn++;
      if (truth === "IRREVERSIBLE") {
        missedEscalations++; // committed to a recoverable verdict for an irreversible action
        if (pred === "NULLIPOTENT" || pred === "REVERSIBLE") dangerousMisses++; // the catastrophic subset
      }
    }
  }

  const perClass: ClassMetric[] = CLASSES.map((cls) => {
    const { tp, fp, fn, support } = tally[cls];
    return { cls, tp, fp, fn, support, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) };
  });

  const irr = tally["IRREVERSIBLE"];
  return {
    perClass,
    n: rows.length,
    abstained,
    missedEscalations,
    dangerousMisses,
    committedCorrect,
    committedTotal,
    irreversibleRecallCI: wilson(irr.tp, irr.support),
    totalCost,
  };
}
