/**
 * Toffoli — FsWorld's durability behaviour under crashes and concurrent callers.
 *
 * fs-world.test.ts proves the happy path restores real disk state. This file proves what happens
 * when the process does NOT survive the compensation, and when two of them share a root. Both
 * defects locked down here were reproduced against the pre-journal adapter first — see
 * docs/plans/plans/2026-08-01-fs-journal-chaos.md.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
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
