/**
 * Toffoli — bootstrap confidence intervals for the at-scale eval.
 *
 * The hand-labeled set is tiny, so its Wilson interval is wide. On the larger generated held-out
 * set (dataset/generate.ts) we report a percentile-bootstrap CI for IRREVERSIBLE recall — resampling
 * the labeled set with replacement and taking the 2.5/97.5 percentiles of the recall distribution.
 * Bootstrap is the right tool for a compound metric on a controlled distribution; Wilson stays the
 * default for a single proportion on the small hand-labeled set. Deterministic (seeded).
 */

import { classifyDeterministic } from "./classify";
import type { GroundTruthSample } from "./types";

function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** IRREVERSIBLE recall, rules-alone (an abstention counts as a miss). */
export function irreversibleRecall(rows: GroundTruthSample[]): number | null {
  let tp = 0;
  let support = 0;
  for (const r of rows) {
    if (r.target.class !== "IRREVERSIBLE") continue;
    support++;
    if (classifyDeterministic(r.action)?.class === "IRREVERSIBLE") tp++;
  }
  return support === 0 ? null : tp / support;
}

export interface BootstrapCI {
  point: number | null;
  lo: number;
  hi: number;
  n: number;
  resamples: number;
}

/** Percentile-bootstrap 95% CI for IRREVERSIBLE recall. */
export function bootstrapRecallCI(rows: GroundTruthSample[], opts: { resamples?: number; seed?: number } = {}): BootstrapCI {
  const irr = rows.filter((r) => r.target.class === "IRREVERSIBLE");
  const n = irr.length;
  const point = irreversibleRecall(rows);
  const B = opts.resamples ?? 2000;
  const rng = lcg(opts.seed ?? 99);
  // Precompute per-row hit (1 if classified IRREVERSIBLE, else 0) so resampling is cheap.
  const hit = irr.map((r) => (classifyDeterministic(r.action)?.class === "IRREVERSIBLE" ? 1 : 0));
  const stats: number[] = [];
  for (let b = 0; b < B; b++) {
    let tp = 0;
    for (let i = 0; i < n; i++) tp += hit[Math.floor(rng() * n)]!;
    stats.push(n ? tp / n : 0);
  }
  stats.sort((a, b) => a - b);
  return { point, lo: stats[Math.floor(0.025 * B)] ?? 0, hi: stats[Math.floor(0.975 * B)] ?? 1, n, resamples: B };
}
