/**
 * Toffoli — SqlWorld's idempotency semantics across the lifetime of a DURABLE database.
 *
 * sql-world.test.ts proves the happy path on a throwaway `:memory:` DB, where every run starts from
 * nothing. This file exercises the mode the module actually advertises — "a replayed compensation is
 * a no-op even across a process restart when backed by a file" — where the `applied` markers OUTLIVE
 * the process that wrote them. That is where an idempotency key stops being a private detail and
 * becomes a name that must not be reused.
 */

import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlWorld, sqlRunInverse } from "./sql-world";

const dirs: string[] = [];
/** A fresh durable database path. Each test gets its own; all are removed afterwards. */
function freshDb(): string {
  const d = mkdtempSync(join(tmpdir(), "toffoli-sqldur-"));
  dirs.push(d);
  return join(d, "world.db");
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Run `fn` against a world on `db` and always close the handle. */
function withWorld<T>(db: string, fn: (w: SqlWorld) => T): T {
  const w = new SqlWorld(db);
  try {
    return fn(w);
  } finally {
    w.close();
  }
}

describe("SqlWorld — an idempotency key names ONE compensation, for the life of the database", () => {
  it("does not report a restore that never happened after the database is reopened", () => {
    const db = freshDb();

    // Run 1: damage a row and genuinely compensate it. The marker is now durable.
    withWorld(db, (w) => {
      w.seedRow("orders", "1001", { customer: "acme" });
      const del = w.softDeleteRow("orders", "1001");
      expect(w.restoreRow(del.target!.id!, `restitution:${del.id}:restore`)).toBe(true);
    });

    // Run 2: a NEW process, the SAME database, a DIFFERENT row. Its compensation has never run.
    withWorld(db, (w) => {
      w.seedRow("orders", "2002", { customer: "globex" });
      const del = w.softDeleteRow("orders", "2002");
      const reported = w.restoreRow(del.target!.id!, `restitution:${del.id}:restore`);
      const snap = w.snapshot();

      // Reporting `true` here while the row is still deleted is a FABRICATED restoration — the exact
      // failure the rest of this repo exists to prevent. The row must actually be back.
      expect(snap.rows["orders:2002"]).toEqual({ customer: "globex" });
      expect(snap.trashRows["orders:2002"]).toBeUndefined();
      expect(reported).toBe(true);
    });
  });

  it("does not skip a second run's refund as an already-applied replay", () => {
    const db = freshDb();

    withWorld(db, (w) => {
      const chg = w.charge("acme", 100);
      expect(w.refund(100, `restitution:${chg.id}:refund`)).toBe(true);
      expect(w.snapshot().ledgerUsd).toBe(0);
    });

    // A brand new $250 charge, compensated for the first time. The money must actually go back.
    withWorld(db, (w) => {
      const chg = w.charge("globex", 250);
      expect(w.snapshot().ledgerUsd).toBe(250);
      const reported = w.refund(250, `restitution:${chg.id}:refund`);
      expect(w.snapshot().ledgerUsd).toBe(0); // reported refunded ⟹ the money moved
      expect(reported).toBe(true);
    });
  });

  it("can still record an external send after the database is reopened", () => {
    const db = freshDb();
    withWorld(db, (w) => w.sendEmail("a@example.test", "one"));
    withWorld(db, (w) => {
      w.sendEmail("b@example.test", "two");
      expect(w.snapshot().outbox).toEqual(["a@example.test: one", "b@example.test: two"]);
    });
  });

  it("mints a distinct action id for every action the database has ever seen", () => {
    fc.assert(
      fc.property(
        // an arbitrary number of process lifetimes, each doing an arbitrary amount of damage
        fc.array(fc.array(fc.constantFrom("row", "charge", "email", "file"), { minLength: 0, maxLength: 5 }), { minLength: 1, maxLength: 6 }),
        (runs) => {
          const db = freshDb();
          const ids: string[] = [];
          let n = 0;
          for (const ops of runs) {
            withWorld(db, (w) => {
              for (const op of ops) {
                n += 1;
                if (op === "row") {
                  w.seedRow("t", String(n), { n });
                  ids.push(w.softDeleteRow("t", String(n)).id);
                } else if (op === "charge") ids.push(w.charge("m", 1).id);
                else if (op === "email") ids.push(w.sendEmail(`u${n}@example.test`, "x").id);
                else ids.push(w.writeFile(`/f${n}.txt`, "x").id);
              }
            });
          }
          // Two actions sharing an id share every idempotency key derived from it, which makes one
          // of their compensations invisible to the other. Uniqueness is the whole guarantee.
          expect(new Set(ids).size).toBe(ids.length);
        },
      ),
      { seed: 20260802, numRuns: 60 },
    );
  });

  it("compensates every damaged row across arbitrarily many reopens, or reports failure honestly", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 5 }), (runs) => {
        const db = freshDb();
        let n = 0;
        for (const perRun of runs) {
          withWorld(db, (w) => {
            for (let i = 0; i < perRun; i++) {
              n += 1;
              const id = String(n);
              w.seedRow("t", id, { n });
              const del = w.softDeleteRow("t", id);
              const reported = w.restoreRow(del.target!.id!, `restitution:${del.id}:restore`);
              // A `true` that is not backed by the row actually being present is a fabricated
              // restoration; a `false` would be honest. Only the fabrication is a defect.
              if (reported) expect(w.snapshot().rows[`t:${id}`]).toEqual({ n });
            }
          });
        }
      }),
      { seed: 20260802, numRuns: 40 },
    );
  });
});

describe("SqlWorld — what a claim means when the effect does not happen", () => {
  it("releases the claim when there is nothing to undo, so a later real attempt still runs", () => {
    const w = new SqlWorld(":memory:");
    try {
      // Nothing in the trash yet: an honest `false`, and the key must NOT be left marked applied.
      expect(w.restoreRow("orders:1", "k")).toBe(false);

      // The same key now names a compensation that really has work to do. Had the no-op kept the
      // claim, this would report success with the row still deleted.
      w.seedRow("orders", "1", { customer: "acme" });
      w.softDeleteRow("orders", "1");
      expect(w.restoreRow("orders:1", "k")).toBe(true);
      expect(w.snapshot().rows["orders:1"]).toEqual({ customer: "acme" });
    } finally {
      w.close();
    }
  });

  it("releases the claim and rethrows when the database rejects the write, so a retry can re-run it", () => {
    const w = new SqlWorld(":memory:");
    try {
      w.charge("acme", 30);
      // A non-finite amount makes the ledger UPDATE violate NOT NULL — a real, thrown SQL failure
      // inside the effect. The runtime classifies transience from the thrown error, so it must
      // reach the caller rather than being swallowed into a `false`.
      expect(() => w.refund(Number.NaN, "r1")).toThrow(/NOT NULL constraint failed/);
      expect(w.snapshot().ledgerUsd).toBe(30); // nothing moved

      // The failed attempt must not have consumed the key.
      expect(w.refund(30, "r1")).toBe(true);
      expect(w.snapshot().ledgerUsd).toBe(0);
    } finally {
      w.close();
    }
  });

  it("keeps the claim when the effect succeeds, so a replay is a success-skip and not a second effect", () => {
    const w = new SqlWorld(":memory:");
    try {
      w.charge("acme", 30);
      expect(w.refund(30, "r1")).toBe(true);
      expect(w.refund(30, "r1")).toBe(true); // replay
      expect(w.snapshot().ledgerUsd).toBe(0); // refunded once, not twice
    } finally {
      w.close();
    }
  });
});

describe("SqlWorld — the file inverse", () => {
  it("deletes a written file once and reports a replay as a success-skip", () => {
    const w = new SqlWorld(":memory:");
    try {
      const act = w.writeFile("/backups/orders.bak", "id,is_test");
      expect(act.target).toEqual({ kind: "file", id: "/backups/orders.bak" });
      expect(w.snapshot().files).toEqual({ "/backups/orders.bak": "id,is_test" });

      expect(w.deleteFile("/backups/orders.bak", "d1")).toBe(true);
      expect(w.snapshot().files).toEqual({});
      expect(w.deleteFile("/backups/orders.bak", "d1")).toBe(true); // replay: skipped, still gone
      expect(w.snapshot().files).toEqual({});
    } finally {
      w.close();
    }
  });

  it("reports a no-op, not a fabricated success, when the file was never there", () => {
    const w = new SqlWorld(":memory:");
    try {
      expect(w.deleteFile("/never-written.txt", "d1")).toBe(false);
    } finally {
      w.close();
    }
  });
});

describe("SqlWorld — damage that captured nothing cannot yield a reported restoration", () => {
  it("an UPDATE with no existing row captures no prior value, and the revert fails honestly", () => {
    const w = new SqlWorld(":memory:");
    try {
      const upd = w.updateRow("users", "ghost", { tier: "WIPED" });
      // No prior state to advertise — the classifier must not be handed a `priorState` that isn't
      // there, or it would commit to `update:prior-state-captured` for an unrecoverable write.
      expect(upd.target?.priorState).toBeUndefined();
      expect(w.snapshot().trashRows).toEqual({});

      const out = sqlRunInverse("restore-prior", { id: "users:ghost" }, `restitution:${upd.id}:restore-prior`, w);
      expect(out.status).toBe("failed");
      expect(w.snapshot().rows["users:ghost"]).toEqual({ tier: "WIPED" }); // nothing fabricated back
    } finally {
      w.close();
    }
  });

  it("a soft delete of a row that was never there leaves no trash copy, and the restore fails honestly", () => {
    const w = new SqlWorld(":memory:");
    try {
      const del = w.softDeleteRow("orders", "ghost");
      expect(w.snapshot().trashRows).toEqual({});
      expect(w.restoreRow(del.target!.id!, `restitution:${del.id}:restore`)).toBe(false);
      expect(w.snapshot().rows).toEqual({});
    } finally {
      w.close();
    }
  });

  it("a DROP destroys the rows with no trash copy — the thing that makes it genuinely irreversible", () => {
    const w = new SqlWorld(":memory:");
    try {
      w.seedTable("logs");
      w.seedRow("logs", "1", { line: "boot ok" });
      w.seedRow("users", "1", { name: "Ada" });
      w.dropTable("logs");

      const snap = w.snapshot();
      expect(snap.tables).toEqual([]);
      expect(snap.rows).toEqual({ "users:1": { name: "Ada" } }); // only the dropped table's rows died
      expect(snap.trashRows).toEqual({}); // and nothing was kept that could fake a recovery
    } finally {
      w.close();
    }
  });
});

describe("sqlRunInverse — the SQL dispatch seam's failure paths", () => {
  /** A world whose restore always fails the way a locked database would. */
  const throwingWorld = {
    deleteFile: () => true,
    restoreRow: () => {
      throw new Error("database is locked");
    },
    refund: () => true,
    snapshot: () => ({ files: {}, rows: {}, trashRows: {}, tables: [], ledgerUsd: 0, outbox: [] }),
  };

  it("refuses a revert with no row id instead of reporting a silent success", () => {
    for (const method of ["restore-prior", "restore-version", "rollback-transaction"]) {
      const out = sqlRunInverse(method, { to: { tier: "free" } }, `restitution:x:${method}`, throwingWorld);
      expect(out.status).toBe("unsupported"); // escalated to a human, never "restored"
      expect(out.detail).toContain(method);
    }
  });

  it("reports a thrown revert as failed WITH the error attached, so the runtime can classify it", () => {
    const out = sqlRunInverse("restore-prior", { id: "users:1" }, "restitution:op1:restore-prior", throwingWorld);
    expect(out.status).toBe("failed");
    expect(out.detail).toBe("database is locked");
    expect(out.error).toBeInstanceOf(Error);
  });

  it("reports an honest failure when there is no captured prior value to revert to", () => {
    const w = new SqlWorld(":memory:");
    try {
      const out = sqlRunInverse("restore-prior", { id: "users:1" }, "restitution:op1:restore-prior", w);
      expect(out.status).toBe("failed"); // never "restored" — nothing was captured
      expect(out.detail).toContain("no captured prior");
    } finally {
      w.close();
    }
  });

  it("delegates every other method to the default dispatcher", () => {
    const w = new SqlWorld(":memory:");
    try {
      w.charge("acme", 12);
      expect(sqlRunInverse("refund", { amountUsd: 12 }, "restitution:op1:refund", w).status).toBe("restored");
      expect(w.snapshot().ledgerUsd).toBe(0);
    } finally {
      w.close();
    }
  });
});
