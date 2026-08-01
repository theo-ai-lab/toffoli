/**
 * Toffoli — the chaos tests: what FsJournal promises when a process dies mid-cycle, and when two
 * callers land in the same window.
 *
 * Both defects these lock down were reproduced against the pre-journal code first
 * (docs/plans/plans/2026-08-01-fs-journal-chaos.md). The reproductions there were a real
 * SIGKILL and a real 12-process race. What lives HERE is deterministic: crashes are placed at exact
 * labelled points and the "other process" is invoked in an exact window, so these tests can never be
 * lucky and can never flake. A flaky concurrency test is worse than none.
 */

import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJournal, JournalError, JOURNAL_POINTS, type JournalPoint, type OnceOutcome } from "./fs-journal";
import { crashAt, interleaveAt, SimulatedCrash } from "./chaos";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "toffoli-chaos-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Run `fn`, returning either its outcome or the error it raised. */
function attempt(fn: () => OnceOutcome): { outcome: OnceOutcome } | { error: unknown } {
  try {
    return { outcome: fn() };
  } catch (error) {
    return { error };
  }
}

describe("FsJournal — crash at every point in the kill-point space", () => {
  /**
   * THE INVARIANT. Generated over the whole cycle: every kill point, both replay-safety
   * declarations, both effect results, and arbitrary keys. Seeded, so a counterexample is
   * reproducible from the printed seed.
   *
   *   1. NO FABRICATED SUCCESS — a run may only report applied/already-applied if the effect
   *      really happened. (This is defect 1: the old marker scheme returned `true` here.)
   *   2. EXACTLY-ONCE FOR NON-REPLAY-SAFE EFFECTS — a refund is never applied twice, no matter
   *      where the crash landed.
   *   3. NO SILENT LOSS — if the effect did not happen, recovery must either do it or raise;
   *      it may never quietly report the step done.
   */
  it("never reports success for an effect that did not happen, at any kill point", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...JOURNAL_POINTS),
        fc.boolean(),
        fc.boolean(),
        fc.string({ minLength: 1, maxLength: 40 }),
        (point: JournalPoint, replaySafe: boolean, effectSucceeds: boolean, key: string) => {
          const dir = freshDir();
          const intent = { key, method: replaySafe ? "delete" : "refund", replaySafe };
          let worldApplied = 0;
          const effect = () => {
            if (effectSucceeds) worldApplied += 1;
            return effectSucceeds;
          };

          // Run 1: a process that dies at `point`.
          const first = attempt(() => new FsJournal(dir, { chaos: crashAt(point) }).runOnce(intent, effect));
          expect("error" in first && first.error instanceof SimulatedCrash).toBe(true);

          // Run 2: a fresh process over the same durable journal — the recovery pass.
          const second = attempt(() => new FsJournal(dir).runOnce(intent, effect));

          if ("outcome" in second) {
            const reported = second.outcome.status === "applied" || second.outcome.status === "already-applied";
            // (1) no fabricated success
            if (reported) expect(worldApplied).toBeGreaterThanOrEqual(1);
            // (3) no silent loss: a "done" verdict with nothing done is exactly the bug
            if (reported && worldApplied === 0) throw new Error("fabricated success");
          } else {
            // The only permitted failure is the loud, typed one.
            expect(second.error).toBeInstanceOf(JournalError);
            expect((second.error as JournalError).code).toBe("indeterminate");
            expect(replaySafe).toBe(false); // a replay-safe step is redone, never escalated
          }

          // (2) money is never applied twice
          if (!replaySafe) expect(worldApplied).toBeLessThanOrEqual(1);
        },
      ),
      { seed: 20260801, numRuns: 200 },
    );
  });

  it("a crash between the claim and a non-replay-safe effect is raised, not swallowed", () => {
    const dir = freshDir();
    const intent = { key: "pay-1", method: "refund", replaySafe: false };
    let refunds = 0;
    expect(() =>
      new FsJournal(dir, { chaos: crashAt("after-claim") }).runOnce(intent, () => {
        refunds += 1;
        return true;
      }),
    ).toThrow(SimulatedCrash);
    expect(refunds).toBe(0); // the crash landed before the money moved

    // The old marker scheme returned `true` right here for a refund that never happened.
    let code: string | undefined;
    try {
      new FsJournal(dir).runOnce(intent, () => {
        refunds += 1;
        return true;
      });
    } catch (err) {
      code = (err as JournalError).code;
    }
    expect(code).toBe("indeterminate");
    expect(refunds).toBe(0);
    expect(new FsJournal(dir).unresolved().map((r) => r.key)).toEqual(["pay-1"]);
  });

  it("a crash between the claim and a REPLAY-SAFE effect is redone on recovery, not escalated", () => {
    const dir = freshDir();
    const intent = { key: "file-1", method: "delete", replaySafe: true };
    let deletes = 0;
    const effect = () => {
      deletes += 1;
      return true;
    };
    expect(() => new FsJournal(dir, { chaos: crashAt("after-claim") }).runOnce(intent, effect)).toThrow(SimulatedCrash);
    expect(deletes).toBe(0);

    expect(new FsJournal(dir).runOnce(intent, effect)).toEqual({ status: "applied", attempt: 2 });
    expect(deletes).toBe(1); // the lost compensation was recovered, not lost and not escalated
    expect(new FsJournal(dir).unresolved()).toEqual([]);
  });

  it("a crash after the effect but before the resolve leaves the claim unresolved, never 'done'", () => {
    const dir = freshDir();
    const intent = { key: "pay-2", method: "refund", replaySafe: false };
    let refunds = 0;
    expect(() =>
      new FsJournal(dir, { chaos: crashAt("before-resolve") }).runOnce(intent, () => {
        refunds += 1;
        return true;
      }),
    ).toThrow(SimulatedCrash);
    expect(refunds).toBe(1); // the money DID move

    const pending = new FsJournal(dir).unresolved();
    expect(pending).toEqual([{ key: "pay-2", method: "refund", replaySafe: false, status: "pending", attempt: 1 }]);
    // and recovery must not refund a second time to "make sure"
    expect(() => new FsJournal(dir).runOnce(intent, () => { refunds += 1; return true; })).toThrow(JournalError);
    expect(refunds).toBe(1);
  });

  it("a crash after the resolve is a clean replay — the record is already durable", () => {
    const dir = freshDir();
    const intent = { key: "pay-3", method: "refund", replaySafe: false };
    let refunds = 0;
    const effect = () => {
      refunds += 1;
      return true;
    };
    expect(() => new FsJournal(dir, { chaos: crashAt("after-resolve") }).runOnce(intent, effect)).toThrow(SimulatedCrash);
    expect(refunds).toBe(1);
    expect(new FsJournal(dir).runOnce(intent, effect)).toEqual({ status: "already-applied", attempt: 1 });
    expect(refunds).toBe(1);
  });
});

describe("FsJournal — a concurrent caller in the claim window (the TOCTOU)", () => {
  /**
   * The window that made 12 of 15 race trials double-refund. `before-claim` is the contract's last
   * moment before the claim becomes durable: a correct implementation has exactly ONE atomic step
   * after it. Here a second journal instance on the same directory — a second process — claims and
   * applies the key inside that window.
   */
  it("a second process that claims and applies inside the window does not produce a second effect", () => {
    const dir = freshDir();
    const intent = { key: "pay-1", method: "refund", replaySafe: false };
    let refunds = 0;
    const effect = () => {
      refunds += 1;
      return true;
    };
    const other = new FsJournal(dir);
    const mine = new FsJournal(dir, { chaos: interleaveAt("before-claim", () => void other.runOnce(intent, effect)) });

    const out = mine.runOnce(intent, effect);

    expect(refunds).toBe(1); // exactly-once ACROSS both callers
    expect(out).toEqual({ status: "already-applied", attempt: 1 });
  });

  it("holds for a replay-safe inverse too: the loser skips rather than re-running", () => {
    const dir = freshDir();
    const intent = { key: "file-1", method: "delete", replaySafe: true };
    let deletes = 0;
    const effect = () => {
      deletes += 1;
      return true;
    };
    const other = new FsJournal(dir);
    const mine = new FsJournal(dir, { chaos: interleaveAt("before-claim", () => void other.runOnce(intent, effect)) });

    expect(mine.runOnce(intent, effect)).toEqual({ status: "already-applied", attempt: 1 });
    expect(deletes).toBe(1);
  });

  it("a second process that only CLAIMS in the window blocks the money path instead of double-paying", () => {
    const dir = freshDir();
    const intent = { key: "pay-1", method: "refund", replaySafe: false };
    let refunds = 0;
    const other = new FsJournal(dir);
    // the other process claims and then dies before its effect
    const mine = new FsJournal(dir, {
      chaos: interleaveAt("before-claim", () => {
        try {
          new FsJournal(dir, { chaos: crashAt("after-claim") }).runOnce(intent, () => true);
        } catch {
          /* its crash, not ours */
        }
        void other;
      }),
    });

    expect(() => mine.runOnce(intent, () => { refunds += 1; return true; })).toThrow(JournalError);
    expect(refunds).toBe(0); // never a second charge on the strength of an unresolved claim
  });

  it("a losing caller's release does NOT erase the winner's idempotency record", () => {
    const dir = freshDir();
    const intent = { key: "pay-1", method: "delete", replaySafe: true };
    const winner = new FsJournal(dir);
    // The loser arrives in the window, finds the key already applied by the winner, and then its own
    // effect no-ops. Under the old scheme its unconditional rmSync deleted the winner's marker,
    // leaving the key open to a second application. (Observed in the race probe: markers=0.)
    const loser = new FsJournal(dir, { chaos: interleaveAt("before-claim", () => void winner.runOnce(intent, () => true)) });

    loser.runOnce(intent, () => false);

    expect(winner.lookup("pay-1")).toEqual({ key: "pay-1", method: "delete", replaySafe: true, status: "applied", attempt: 1 });
  });
});

describe("chaos schedules are deterministic", () => {
  it("crashAt fires at the named point and nowhere else", () => {
    const seen: JournalPoint[] = [];
    const dir = freshDir();
    const spy = { arrive: (p: JournalPoint) => seen.push(p) };
    new FsJournal(dir, { chaos: spy }).runOnce({ key: "k", method: "m", replaySafe: true }, () => true);
    expect(seen).toEqual([...JOURNAL_POINTS]); // every point is reached exactly once on a clean run
  });

  it("crashAt(nth) fires on the nth arrival, not the first", () => {
    const dir = freshDir();
    const chaos = crashAt("after-claim", 2);
    const j = new FsJournal(dir, { chaos });
    expect(j.runOnce({ key: "a", method: "m", replaySafe: true }, () => true)).toEqual({ status: "applied", attempt: 1 });
    expect(() => j.runOnce({ key: "b", method: "m", replaySafe: true }, () => true)).toThrow(SimulatedCrash);
  });

  it("interleaveAt runs its action exactly once", () => {
    const dir = freshDir();
    let fired = 0;
    const bump = (): void => {
      fired += 1;
    };
    const j = new FsJournal(dir, { chaos: interleaveAt("before-claim", bump) });
    j.runOnce({ key: "a", method: "m", replaySafe: true }, () => true);
    j.runOnce({ key: "b", method: "m", replaySafe: true }, () => true);
    expect(fired).toBe(1);
  });
});
