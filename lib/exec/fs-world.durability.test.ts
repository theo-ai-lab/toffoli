/**
 * Toffoli — FsWorld's durability behaviour under crashes and concurrent callers.
 *
 * fs-world.test.ts proves the happy path restores real disk state. This file proves what happens
 * when the process does NOT survive the compensation, and when two of them share a root. Both
 * defects locked down here were reproduced against the pre-journal adapter first — see
 * docs/plans/plans/2026-08-01-fs-journal-chaos.md.
 */

import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsWorld } from "./fs-world";
import { JournalError } from "./fs-journal";
import { crashAt, interleaveAt, SimulatedCrash } from "./chaos";
import { dispatchInverse } from "./executor";

const roots: string[] = [];
function freshRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "toffoli-fsdur-"));
  roots.push(r);
  return r;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("FsWorld — a compensation is never silently lost", () => {
  it("a refund that crashed after claiming is NOT reported as done by the next process", () => {
    const root = freshRoot();
    new FsWorld(root).charge("acme", 50);

    // the process dies between claiming the key and moving the money
    expect(() => new FsWorld(root, { chaos: crashAt("after-claim") }).refund(50, "r1")).toThrow(SimulatedCrash);
    expect(new FsWorld(root).snapshot().ledgerUsd).toBe(50); // money still taken

    // The pre-journal adapter returned `true` here — a refund reported for money that never moved.
    let err: unknown;
    try {
      new FsWorld(root).refund(50, "r1");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JournalError);
    expect((err as JournalError).code).toBe("indeterminate");
    expect(new FsWorld(root).snapshot().ledgerUsd).toBe(50); // and it did not quietly refund twice either
  });

  it("the executor turns that indeterminate compensation into a FAILED step, not a restored one", () => {
    const root = freshRoot();
    new FsWorld(root).charge("acme", 50);
    expect(() => new FsWorld(root, { chaos: crashAt("after-claim") }).refund(50, "r1")).toThrow(SimulatedCrash);

    const out = dispatchInverse("refund", { amountUsd: 50 }, "r1", new FsWorld(root));
    expect(out.status).toBe("failed"); // a saga resume point, never a fabricated restoration
    expect(out.error).toBeInstanceOf(JournalError);
  });

  it("a replay-safe inverse that crashed after claiming IS recovered on the next run", () => {
    const root = freshRoot();
    const w = new FsWorld(root);
    w.writeFile("/backups/orders.bak", "id,is_test");
    expect(() => new FsWorld(root, { chaos: crashAt("after-claim") }).deleteFile("/backups/orders.bak", "d1")).toThrow(SimulatedCrash);
    expect(existsSync(join(root, "files", "backups", "orders.bak"))).toBe(true); // not deleted yet

    expect(new FsWorld(root).deleteFile("/backups/orders.bak", "d1")).toBe(true);
    expect(existsSync(join(root, "files", "backups", "orders.bak"))).toBe(false); // redone, not lost
  });

  it("an unresolved money claim is visible to a recovery pass instead of disappearing", () => {
    const root = freshRoot();
    const w = new FsWorld(root);
    w.charge("acme", 50);
    expect(() => new FsWorld(root, { chaos: crashAt("after-claim") }).refund(50, "r1")).toThrow(SimulatedCrash);
    expect(new FsWorld(root).unresolvedCompensations().map((r) => ({ key: r.key, method: r.method }))).toEqual([
      { key: "r1", method: "refund" },
    ]);
  });
});

describe("FsWorld — two callers on one root", () => {
  it("a second process refunding the same key in the claim window does not double-refund", () => {
    const root = freshRoot();
    new FsWorld(root).charge("acme", 100);
    const other = new FsWorld(root);
    const mine = new FsWorld(root, { chaos: interleaveAt("before-claim", () => void other.refund(50, "r1")) });

    expect(mine.refund(50, "r1")).toBe(true);
    expect(new FsWorld(root).snapshot().ledgerUsd).toBe(50); // exactly one $50 refund, not two
  });

  it("a losing caller's no-op does not erase the winner's idempotency record", () => {
    const root = freshRoot();
    const w = new FsWorld(root);
    w.writeFile("/a.txt", "x");
    const winner = new FsWorld(root);
    const loser = new FsWorld(root, { chaos: interleaveAt("before-claim", () => void winner.deleteFile("/a.txt", "d1")) });

    loser.deleteFile("/a.txt", "d1"); // the file is already gone, so this caller's effect no-ops

    expect(readdirSync(join(root, "applied")).length).toBe(1); // the winner's record survives
    expect(new FsWorld(root).deleteFile("/a.txt", "d1")).toBe(true); // and still reads as applied
  });
});

/**
 * The journal's records are DURABLE — that is the whole point of it. So the names those records are
 * filed under (idempotency keys, derived from the action id) stop being a private per-process detail
 * the moment a root outlives the process that created it, which is the mode this adapter advertises
 * and the MCP deployment documents (`TOFFOLI_MCP_FS_ROOT=<the directory the agent works in>`). An id
 * that repeats after a reopen makes a compensation that has NEVER run look like a replay of one that
 * has: `once()` short-circuits on the prior `applied` record and returns success for work that did
 * not happen — a fabricated restoration, and for `refund` it slips past the not-replay-safe check,
 * because an applied record is answered before the indeterminate branch is ever reached.
 */
describe("FsWorld — an action id names ONE compensation, for the life of the root", () => {
  it("does not report a restore that never happened after the root is reopened", () => {
    const root = freshRoot();

    // Run 1: damage a row and genuinely compensate it. The claim record is now durable on disk.
    {
      const w = new FsWorld(root);
      w.seedRow("orders", "1001", { customer: "acme" });
      const del = w.softDeleteRow("orders", "1001");
      expect(w.restoreRow(del.target!.id!, `restitution:${del.id}:restore`)).toBe(true);
    }

    // Run 2: a NEW process, the SAME root, a DIFFERENT row. Its compensation has never run.
    {
      const w = new FsWorld(root);
      w.seedRow("orders", "2002", { customer: "globex" });
      const del = w.softDeleteRow("orders", "2002");
      const reported = w.restoreRow(del.target!.id!, `restitution:${del.id}:restore`);
      const snap = w.snapshot();

      // Reporting `true` while the row is still in the trash is the fabricated restoration the rest
      // of this repo exists to prevent. The row has to actually be back.
      expect(snap.rows["orders:2002"]).toEqual({ customer: "globex" });
      expect(snap.trashRows["orders:2002"]).toBeUndefined();
      expect(reported).toBe(true);
    }
  });

  it("does not skip a second run's refund as an already-applied replay", () => {
    const root = freshRoot();

    {
      const w = new FsWorld(root);
      const chg = w.charge("acme", 100);
      expect(w.refund(100, `restitution:${chg.id}:refund`)).toBe(true);
      expect(w.snapshot().ledgerUsd).toBe(0);
    }

    // A brand-new $250 charge, compensated for the FIRST time. `replaySafe:false` cannot help here:
    // an `applied` record is answered before the indeterminate check, so a reused key returns a
    // silent success and the money stays taken.
    {
      const w = new FsWorld(root);
      const chg = w.charge("globex", 250);
      expect(w.snapshot().ledgerUsd).toBe(250);
      const reported = w.refund(250, `restitution:${chg.id}:refund`);
      expect(w.snapshot().ledgerUsd).toBe(0); // reported refunded ⟹ the money moved
      expect(reported).toBe(true);
    }
  });

  it("an external send in a later run does not overwrite the record of an earlier one", () => {
    const root = freshRoot();
    new FsWorld(root).sendEmail("a@example.test", "one");
    const w = new FsWorld(root);
    w.sendEmail("b@example.test", "two");
    // The outbox is the durable evidence that an IRREVERSIBLE action happened. A reused id files the
    // second send under the first one's name and destroys that evidence.
    expect(w.snapshot().outbox).toEqual(["a@example.test: one", "b@example.test: two"]);
  });

  it("two live handles on one root never mint the same action id", () => {
    const root = freshRoot();
    const a = new FsWorld(root);
    const b = new FsWorld(root);
    // Interleaved deterministically rather than raced: allocation must be exclusive, not lucky.
    const ids = [a.charge("m", 1).id, b.charge("m", 1).id, a.charge("m", 1).id, b.charge("m", 1).id];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps allocating ids when the id directory holds a number it cannot increment", () => {
    const root = freshRoot();
    const first = new FsWorld(root).charge("m", 1).id;
    // A number past 2^53 would stop the probe advancing — this must be skipped, not hung on.
    writeFileSync(join(root, "ids", "op99999999999999999999"), "");
    const next = new FsWorld(root).charge("m", 1).id;
    expect(next).toMatch(/^op\d+$/);
    expect(next).not.toBe(first);
  });

  it("keeps action timestamps valid and ordered past the first hour of the sequence", () => {
    // A durable counter passes 59, so the timestamp has to survive it: LIFO compensation order is a
    // STRING SORT on `at` (lib/engine/plan.ts), and a minute field of `100` both sorts before `99`
    // and is not a parseable instant. Reachable in one process today, unavoidable on a durable root.
    const w = new FsWorld(freshRoot());
    const stamps = Array.from({ length: 120 }, () => w.charge("m", 0).at!);
    expect([...stamps].sort()).toEqual(stamps);
    expect(stamps.filter((s) => Number.isNaN(Date.parse(s)))).toEqual([]);
  });

  it("mints a distinct action id for every action the root has ever seen", () => {
    fc.assert(
      fc.property(
        // an arbitrary number of process lifetimes, each doing an arbitrary amount of damage
        fc.array(fc.array(fc.constantFrom("row", "charge", "email", "file"), { minLength: 0, maxLength: 5 }), { minLength: 1, maxLength: 6 }),
        (runs) => {
          const root = freshRoot();
          const ids: string[] = [];
          let n = 0;
          for (const ops of runs) {
            const w = new FsWorld(root);
            for (const op of ops) {
              n += 1;
              if (op === "row") {
                w.seedRow("orders", String(n), { n });
                ids.push(w.softDeleteRow("orders", String(n)).id);
              } else if (op === "charge") ids.push(w.charge("m", 1).id);
              else if (op === "email") ids.push(w.sendEmail(`u${n}@example.test`, "x").id);
              else ids.push(w.writeFile(`/f${n}.txt`, "x").id);
            }
          }
          // Two actions sharing an id share every idempotency key derived from it, which makes one
          // of their compensations invisible to the other. Uniqueness is the whole guarantee.
          expect(new Set(ids).size).toBe(ids.length);
        },
      ),
      { seed: 20260802, numRuns: 60 },
    );
  });

  it("across arbitrary reopen sequences, every reported compensation really changed the world", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.constantFrom("row", "charge"), { minLength: 0, maxLength: 4 }), { minLength: 1, maxLength: 5 }),
        (runs) => {
          const root = freshRoot();
          let n = 0;
          for (const ops of runs) {
            const w = new FsWorld(root); // a new process lifetime over the same durable root
            for (const op of ops) {
              n += 1;
              if (op === "row") {
                const id = String(n);
                w.seedRow("orders", id, { n });
                const del = w.softDeleteRow("orders", id);
                expect(w.snapshot().trashRows[`orders:${id}`]).toEqual({ n }); // really damaged first
                let reported: boolean;
                try {
                  reported = w.restoreRow(del.target!.id!, `restitution:${del.id}:restore`);
                } catch {
                  continue; // a loud, typed refusal is honest; only a fabricated success is a defect
                }
                if (reported) {
                  const snap = w.snapshot();
                  expect(snap.rows[`orders:${id}`]).toEqual({ n });
                  expect(snap.trashRows[`orders:${id}`]).toBeUndefined();
                }
              } else {
                const before = w.snapshot().ledgerUsd;
                const chg = w.charge("acme", 10);
                expect(w.snapshot().ledgerUsd).toBe(before + 10); // really charged first
                let reported: boolean;
                try {
                  reported = w.refund(10, `restitution:${chg.id}:refund`);
                } catch {
                  continue;
                }
                if (reported) expect(w.snapshot().ledgerUsd).toBe(before); // the money really went back
              }
            }
          }
        },
      ),
      { seed: 20260802, numRuns: 40 },
    );
  });
});

describe("FsWorld — the ledger's atomic replace is per-writer", () => {
  it("a temp path left behind by another writer cannot block this one", () => {
    const root = freshRoot();
    const w = new FsWorld(root);
    // Occupy the SHARED temp name the old implementation used. A directory cannot be overwritten by
    // writeFileSync, so any writer still using the fixed name dies with EISDIR here.
    mkdirSync(join(root, "ledger.json.tmp"));
    w.charge("acme", 20);
    expect(w.snapshot().ledgerUsd).toBe(20);
  });

  it("leaves no temp file behind after a write", () => {
    const root = freshRoot();
    new FsWorld(root).charge("acme", 20);
    expect(readdirSync(root).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});
