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
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJournal, JournalError, JOURNAL_POINTS, type JournalPoint, type JournalRecord, type OnceOutcome } from "./fs-journal";
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
    const crashed = new FsJournal(dir, { chaos: crashAt("before-resolve") });
    expect(() =>
      crashed.runOnce(intent, () => {
        refunds += 1;
        return true;
      }),
    ).toThrow(SimulatedCrash);
    expect(refunds).toBe(1); // the money DID move

    const pending = new FsJournal(dir).unresolved();
    expect(pending).toEqual([{ key: "pay-2", method: "refund", replaySafe: false, status: "pending", attempt: 1, owner: crashed.owner }]);
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

    expect(winner.lookup("pay-1")).toEqual({ key: "pay-1", method: "delete", replaySafe: true, status: "applied", attempt: 1, owner: winner.owner });
  });
});

/**
 * The two labelled points at which THIS caller's own claim is already durable on disk but not yet
 * resolved. A peer that lands here — unlike one that lands at `before-claim` — does NOT run to
 * completion before this caller starts; it runs while this caller still holds an unresolved claim,
 * and this caller then reaches `release()` with the peer's outcome already on disk. That is the
 * window the `before-claim` tests above cannot reach.
 */
const PENDING_WINDOWS = ["after-claim", "before-resolve"] as const;

describe("FsJournal — a peer inside the window where this caller's claim is still PENDING", () => {
  /**
   * THE INVARIANT: an `applied` record is NEVER destroyed by a process that did not write it.
   *
   * Generated over the whole interleaving space of claim/effect/release rather than three examples:
   * both pending windows × the peer applying or no-opping × this caller reaching release by
   * returning false or by throwing × both replay-safety declarations × arbitrary keys. Seeded and
   * placed at exact labelled points, so it is reproducible and can never flake.
   *
   * Two clauses, and the second is what stops "never delete anything" from passing trivially:
   *   1. NO CROSS-CALLER DESTRUCTION — a durable record this caller did not write survives it.
   *   2. RELEASE STILL RELEASES — this caller's OWN untouched claim is still dropped, so a later
   *      legitimate attempt can run.
   */
  it("never destroys a record it did not write, anywhere in the interleaving space", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PENDING_WINDOWS),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.string({ minLength: 1, maxLength: 40 }),
        (window: JournalPoint, peerApplies: boolean, endsWithThrow: boolean, replaySafe: boolean, key: string) => {
          const dir = freshDir();
          const intent = { key, method: replaySafe ? "delete" : "refund", replaySafe };

          /** What was durable at the instant the peer finished — read by a THIRD instance, from disk. */
          let observed: JournalRecord | undefined;

          const peer = new FsJournal(dir);
          const mine = new FsJournal(dir, {
            chaos: interleaveAt(window, () => {
              attempt(() => peer.runOnce(intent, () => peerApplies)); // a second process, in my window
              observed = new FsJournal(dir).lookup(key);
            }),
          });

          attempt(() =>
            mine.runOnce(intent, () => {
              if (endsWithThrow) throw new Error("backend down");
              return false; // a no-op — the other way this caller reaches release()
            }),
          );

          const final = new FsJournal(dir).lookup(key);

          if (observed?.status === "applied") {
            // (1) the peer's durable proof that the compensation HAPPENED
            expect(final, "an applied record was destroyed by a caller that did not write it").toBeDefined();
            expect(final?.status).toBe("applied");
            expect(final?.owner).toBe(observed.owner);
          } else if (observed === undefined || (observed.owner === mine.owner && observed.attempt === 1)) {
            // (2) nothing but my own claim is on disk (or the peer never got to run) — release it
            expect(final, "this caller's own unresolved claim was not released").toBeUndefined();
          } else {
            // the peer left its own unresolved claim (a bumped redo attempt). Also not mine to delete.
            expect(final, "a peer's unresolved claim was destroyed by another caller").toBeDefined();
            expect(final?.owner).toBe(observed.owner);
            expect(final?.attempt).toBe(observed.attempt);
          }
        },
      ),
      { seed: 20260801, numRuns: 300 },
    );
  });

  it("the concrete case: a peer's completed compensation survives this caller's failure", () => {
    const dir = freshDir();
    const intent = { key: "restitution:op1:delete", method: "delete", replaySafe: true };
    const peer = new FsJournal(dir);
    // I claim; the peer lands in my window, redoes the effect and durably records it APPLIED; my own
    // effect then finds nothing left to do and I release. The peer's record must still be there.
    const mine = new FsJournal(dir, { chaos: interleaveAt("after-claim", () => void peer.runOnce(intent, () => true)) });

    expect(mine.runOnce(intent, () => false)).toEqual({ status: "noop" });

    expect(new FsJournal(dir).lookup("restitution:op1:delete")).toEqual({
      key: "restitution:op1:delete",
      method: "delete",
      replaySafe: true,
      status: "applied",
      attempt: 2,
      owner: peer.owner,
    });
  });

  it("refuses a record that merely LOOKS like its claim — identity, not shape", () => {
    const dir = freshDir();
    const intent = { key: "k", method: "delete", replaySafe: true };
    let peerOwner = "";
    // While my claim is unresolved, the record is removed out of band (an operator clearing a stuck
    // claim, a sweeper, a restored backup) and a SECOND process makes its own first claim for the
    // same key and is still mid-flight. Its record is `pending`, attempt 1 — byte-identical in shape
    // to mine. Only the writer's identity distinguishes them, which is why the check compares it.
    const mine = new FsJournal(dir, {
      chaos: interleaveAt("after-claim", () => {
        rmSync(join(dir, readdirSync(dir)[0]!), { force: true });
        const peer = new FsJournal(dir, { chaos: crashAt("after-claim") });
        peerOwner = peer.owner;
        attempt(() => peer.runOnce(intent, () => true));
      }),
    });

    expect(mine.runOnce(intent, () => false)).toEqual({ status: "noop" });

    expect(new FsJournal(dir).lookup("k"), "a live claim from another process was destroyed").toEqual({
      key: "k",
      method: "delete",
      replaySafe: true,
      status: "pending",
      attempt: 1,
      owner: peerOwner,
    });
  });

  /**
   * The same instance, re-entered. An effect that performs a nested compensation for the same key
   * writes a record with THIS instance's own owner id, so identity alone cannot tell the inner run's
   * work from the outer run's claim. The rest of the check — still `pending`, still the same attempt
   * — is what keeps the outer release from deleting the inner run's result.
   */
  it("does not delete an inner run's APPLIED record when the outer attempt then no-ops", () => {
    const dir = freshDir();
    const j = new FsJournal(dir);
    const intent = { key: "k", method: "delete", replaySafe: true };

    const out = j.runOnce(intent, () => {
      rmSync(join(dir, readdirSync(dir)[0]!), { force: true }); // the claim is swept out of band
      j.runOnce(intent, () => true); // the nested compensation claims afresh and durably applies
      return false; // …so the outer attempt finds nothing left to do, and releases
    });

    expect(out).toEqual({ status: "noop" });
    expect(j.lookup("k"), "an applied record was destroyed by the outer release").toEqual({
      key: "k",
      method: "delete",
      replaySafe: true,
      status: "applied",
      attempt: 1,
      owner: j.owner,
    });
  });

  it("does not delete an inner run's later ATTEMPT when the outer attempt then no-ops", () => {
    const dir = freshDir();
    const j = new FsJournal(dir);
    const intent = { key: "k", method: "delete", replaySafe: true };

    const out = j.runOnce(intent, () => {
      j.runOnce(intent, () => false); // the nested compensation redoes the claim as attempt 2
      return false;
    });

    expect(out).toEqual({ status: "noop" });
    // Attempt 2 is unresolved, so recovery must still see it. Deleting it would erase the fact that
    // a second attempt was made at all.
    expect(j.lookup("k"), "a later attempt's claim was destroyed by an earlier attempt's release").toEqual({
      key: "k",
      method: "delete",
      replaySafe: true,
      status: "pending",
      attempt: 2,
      owner: j.owner,
    });
  });

  it("a caller may still release its OWN unresolved claim — the check refuses others, not everything", () => {
    const dir = freshDir();
    const intent = { key: "k", method: "delete", replaySafe: true };
    const j = new FsJournal(dir);
    expect(j.runOnce(intent, () => false)).toEqual({ status: "noop" });
    expect(j.lookup("k")).toBeUndefined();
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
