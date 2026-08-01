/**
 * Toffoli — contract tests for FsJournal, the durable write-ahead claim record.
 *
 * These pin the SEAM: what `runOnce` promises, what it refuses, and what one
 * error shape it raises. The crash/interleaving properties live in
 * fs-journal.chaos.test.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FsJournal, JournalError, type OnceIntent } from "./fs-journal";

const roots: string[] = [];
function freshDir(): string {
  const r = mkdtempSync(join(tmpdir(), "toffoli-journal-"));
  roots.push(r);
  return r;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const REFUND: OnceIntent = { key: "k1", method: "refund", replaySafe: false };
const DELETE: OnceIntent = { key: "k1", method: "delete", replaySafe: true };

describe("FsJournal — the seam contract", () => {
  it("applies the effect once and reports it applied", () => {
    const j = new FsJournal(freshDir());
    let runs = 0;
    const out = j.runOnce(REFUND, () => {
      runs += 1;
      return true;
    });
    expect(out).toEqual({ status: "applied", attempt: 1 });
    expect(runs).toBe(1);
  });

  it("a replay over the same durable record does NOT re-run the effect", () => {
    const dir = freshDir();
    let runs = 0;
    new FsJournal(dir).runOnce(REFUND, () => {
      runs += 1;
      return true;
    });
    // a brand-new instance = a new process over the same on-disk journal
    const out = new FsJournal(dir).runOnce(REFUND, () => {
      runs += 1;
      return true;
    });
    expect(out).toEqual({ status: "already-applied", attempt: 1 });
    expect(runs).toBe(1);
  });

  it("an effect that no-ops releases the claim so a later real attempt can still run", () => {
    const dir = freshDir();
    const j = new FsJournal(dir);
    expect(j.runOnce(DELETE, () => false)).toEqual({ status: "noop" });
    expect(j.lookup("k1")).toBeUndefined(); // claim released, nothing durable to replay
    expect(j.runOnce(DELETE, () => true)).toEqual({ status: "applied", attempt: 1 });
  });

  it("an effect that throws releases the claim and propagates the original error", () => {
    const dir = freshDir();
    const j = new FsJournal(dir);
    const boom = new Error("backend down");
    expect(() => j.runOnce(DELETE, () => { throw boom; })).toThrow(boom);
    expect(j.lookup("k1")).toBeUndefined(); // a failed attempt must be retryable
    expect(j.runOnce(DELETE, () => true)).toEqual({ status: "applied", attempt: 1 });
  });

  it("records the method and replay-safety alongside the key, so recovery can reason about it", () => {
    const dir = freshDir();
    new FsJournal(dir).runOnce(REFUND, () => true);
    expect(new FsJournal(dir).lookup("k1")).toEqual({
      key: "k1",
      method: "refund",
      replaySafe: false,
      status: "applied",
      attempt: 1,
    });
  });

  // ── boundary validation: one error shape, checked at the seam ──

  it.each([
    ["empty key", { key: "", method: "refund", replaySafe: false }],
    ["empty method", { key: "k", method: "", replaySafe: false }],
    ["NUL in key", { key: "a\0b", method: "refund", replaySafe: false }],
    ["non-string key", { key: 7 as unknown as string, method: "refund", replaySafe: false }],
    ["non-boolean replaySafe", { key: "k", method: "m", replaySafe: "yes" as unknown as boolean }],
  ])("rejects %s at the boundary with a typed JournalError, before any effect runs", (_label, bad) => {
    const j = new FsJournal(freshDir());
    let ran = false;
    try {
      j.runOnce(bad as OnceIntent, () => {
        ran = true;
        return true;
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JournalError);
      expect((err as JournalError).code).toBe("invalid-intent");
    }
    expect(ran).toBe(false);
  });

  it("an over-long key is refused rather than silently truncated onto a colliding record", () => {
    const j = new FsJournal(freshDir());
    expect(() => j.runOnce({ key: "x".repeat(1025), method: "m", replaySafe: true }, () => true)).toThrow(JournalError);
  });

  it("a record that is present but unparseable is a LOUD corruption, never a silent re-apply", () => {
    const dir = freshDir();
    const j = new FsJournal(dir);
    j.runOnce(REFUND, () => true);
    const f = readdirSync(dir)[0]!;
    writeFileSync(join(dir, f), "{ not json");
    let ran = false;
    try {
      new FsJournal(dir).runOnce(REFUND, () => {
        ran = true;
        return true;
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JournalError);
      expect((err as JournalError).code).toBe("corrupt-record");
    }
    expect(ran).toBe(false); // the effect must NOT run against an unreadable record
  });

  it("honours a legacy zero-byte marker as an applied record (durable-format upgrade path)", () => {
    const dir = freshDir();
    // what the pre-journal FsWorld wrote: an empty file named by the key hash
    writeFileSync(join(dir, createHash("sha256").update("k1").digest("hex").slice(0, 32)), "");
    let ran = false;
    const out = new FsJournal(dir).runOnce(REFUND, () => {
      ran = true;
      return true;
    });
    expect(out.status).toBe("already-applied");
    expect(ran).toBe(false); // an old root must not be re-applied by the new code
  });

  it("keys that differ only past the hash prefix get distinct records (no collision by truncation)", () => {
    const dir = freshDir();
    const j = new FsJournal(dir);
    j.runOnce({ key: "order:1", method: "refund", replaySafe: false }, () => true);
    j.runOnce({ key: "order:2", method: "refund", replaySafe: false }, () => true);
    expect(readdirSync(dir).length).toBe(2);
    expect(j.lookup("order:1")?.key).toBe("order:1");
    expect(j.lookup("order:2")?.key).toBe("order:2");
  });

  it("unresolved() lists exactly the claims that were never resolved", () => {
    const dir = freshDir();
    const j = new FsJournal(dir);
    j.runOnce({ key: "done", method: "refund", replaySafe: false }, () => true);
    expect(j.unresolved()).toEqual([]);
  });

  it("unresolved() surfaces a corrupt record instead of quietly skipping it", () => {
    const dir = freshDir();
    const j = new FsJournal(dir);
    j.runOnce(REFUND, () => true);
    writeFileSync(join(dir, readdirSync(dir)[0]!), "{ not json");
    try {
      j.unresolved();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JournalError);
      expect((err as JournalError).code).toBe("corrupt-record");
    }
  });

  it("a non-object intent is refused rather than dereferenced", () => {
    const j = new FsJournal(freshDir());
    for (const bad of [null, undefined, "k1", 42]) {
      try {
        j.runOnce(bad as unknown as OnceIntent, () => true);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(JournalError);
        expect((err as JournalError).code).toBe("invalid-intent");
      }
    }
  });

  it("a claim the filesystem refuses is an io error, distinct from losing the claim", () => {
    const dir = freshDir();
    const j = new FsJournal(dir);
    chmodSync(dir, 0o500); // read-only journal dir → the claim write fails with EACCES
    try {
      j.runOnce(REFUND, () => true);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JournalError);
      expect((err as JournalError).code).toBe("io");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("writes no stray temp files behind an applied record", () => {
    const dir = freshDir();
    new FsJournal(dir).runOnce(REFUND, () => true);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("the durable record is valid JSON on disk, not an opaque blob", () => {
    const dir = freshDir();
    new FsJournal(dir).runOnce(REFUND, () => true);
    const raw = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    expect(JSON.parse(raw)).toMatchObject({ key: "k1", status: "applied" });
  });
});
