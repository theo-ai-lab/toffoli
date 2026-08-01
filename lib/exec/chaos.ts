/**
 * Toffoli — deterministic chaos schedules for the journal's kill-point space.
 *
 * Concurrency and crash bugs are usually "reproduced" by running something many times and hoping.
 * That produces flaky tests, and a flaky test is worse than no test: it trains you to re-run. These
 * schedules make the interesting moment ADDRESSABLE instead. `FsJournal` announces four labelled
 * points per cycle; a schedule decides what happens when execution arrives at one. Crashing at the
 * third arrival at `before-resolve` is then an exact instruction, not a dice roll — the same idea as
 * a deterministic simulation harness, at the scale this adapter needs.
 *
 * Nothing here runs in production: `FsJournal` only consults a schedule if one was passed in.
 *
 * Zero dependencies.
 */

import type { ChaosSchedule, JournalPoint } from "./fs-journal";

/**
 * Thrown to model a process that died at a labelled point. It is deliberately NOT a JournalError:
 * a simulated crash is not an outcome the seam can report, it is the absence of one.
 */
export class SimulatedCrash extends Error {
  readonly point: JournalPoint;
  readonly key: string;

  constructor(point: JournalPoint, key: string) {
    super(`simulated crash at ${point} for ${JSON.stringify(key)}`);
    this.name = "SimulatedCrash";
    this.point = point;
    this.key = key;
  }
}

/**
 * Die at the `nth` arrival at `point` (1-based, default the first). Every other arrival passes
 * through untouched, so a schedule can target one step of a multi-step recovery.
 */
export function crashAt(point: JournalPoint, nth = 1): ChaosSchedule {
  let seen = 0;
  return {
    arrive(at: JournalPoint, key: string): void {
      if (at !== point) return;
      seen += 1;
      if (seen === nth) throw new SimulatedCrash(point, key);
    },
  };
}

/**
 * Run `action` at the `nth` arrival at `point` — the deterministic stand-in for another process
 * landing in that exact window. Used to place a competing claim inside the claim window without
 * racing for it.
 */
export function interleaveAt(point: JournalPoint, action: (key: string) => void, nth = 1): ChaosSchedule {
  let seen = 0;
  return {
    arrive(at: JournalPoint, key: string): void {
      if (at !== point) return;
      seen += 1;
      if (seen === nth) action(key);
    },
  };
}
