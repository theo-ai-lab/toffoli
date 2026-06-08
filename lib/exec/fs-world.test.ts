/**
 * Toffoli — tests for the real-filesystem recovery adapter (FsWorld).
 *
 * These pin that the EXACT executor + safe-executor that run on the in-memory sandbox also restore
 * real on-disk state to a byte-identical baseline, leave the irreversible dimensions untouched, and
 * — the property a real system must have — are idempotent across a process restart (the applied
 * markers persist, so a replay never double-applies). Everything runs under a throwaway temp dir.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsWorld } from "./fs-world";
import { World } from "./world";
import { fsRecoveryScenario } from "./fs-recover";
import { execute } from "./executor";
import { planResumable } from "../engine/resumable";
import { classifyDeterministic } from "../engine/classify";
import { safeExecute, computeConfirmToken } from "../runtime/safe-executor";
import { SANDBOX_AUTO_POLICY } from "../runtime/policy";
import type { AgentAction, Classification } from "../engine/types";

const roots: string[] = [];
function freshRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "toffoli-fstest-"));
  roots.push(r);
  return r;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function classify(a: AgentAction): Classification {
  return classifyDeterministic(a) ?? { actionId: a.id, class: "IRREVERSIBLE", idempotent: false, confidence: 0, llmAssisted: false, ruleRef: "abstain", rationale: "fail-safe" };
}

/** Build the canonical damage scenario on a given FsWorld; returns the plan + the pre-damage baseline. */
function damage(world: FsWorld) {
  world.seedRow("orders", "t1", { is_test: true });
  world.seedRow("orders", "t2", { is_test: true });
  world.seedTable("orders_archive");
  const baseline = world.snapshot();
  const actions: AgentAction[] = [
    world.writeFile("/backups/orders.bak", "id,is_test"),
    world.softDeleteRow("orders", "t1"),
    world.softDeleteRow("orders", "t2"),
    world.charge("enrich-api", 12),
    world.dropTable("orders_archive"),
    world.sendEmail("client@acme.com", "summary attached"),
  ];
  const classifications = actions.map(classify);
  return { plan: planResumable(actions, classifications), baseline, actions, classifications };
}

describe("FsWorld — end-to-end recovery on the real filesystem", () => {
  it("restores the recoverable subset to a byte-identical baseline ON DISK, with restraint + durable idempotency", () => {
    const r = fsRecoveryScenario({ keep: false });
    expect(r.recoverableRestored).toBe(true); // real files/rows/ledger match the pre-damage baseline
    expect(r.irreversibleUntouched).toBe(true); // dropped table + sent email never touched
    expect(r.idempotentOnReplay).toBe(true); // a fresh process replays as a pure no-op
    expect(r.result.restored).toBe(r.totals.recoverable);
  });

  it("really writes and really deletes: the backup file exists after damage and is gone after recovery", () => {
    const root = freshRoot();
    const world = new FsWorld(root);
    const { plan } = damage(world);
    expect(existsSync(join(root, "files", "backups", "orders.bak"))).toBe(true); // really on disk
    execute(plan, world, {});
    expect(existsSync(join(root, "files", "backups", "orders.bak"))).toBe(false); // really removed
  });

  it("a deleted row really moves to a trash dir and is really restored from it", () => {
    const root = freshRoot();
    const world = new FsWorld(root);
    const { plan } = damage(world);
    expect(existsSync(join(root, "trash", "rows", "orders", "t1.json"))).toBe(true); // soft-deleted to real trash
    expect(existsSync(join(root, "rows", "orders", "t1.json"))).toBe(false);
    execute(plan, world, {});
    expect(existsSync(join(root, "rows", "orders", "t1.json"))).toBe(true); // really restored
  });

  it("durable idempotency: replaying the refund from a fresh FsWorld does NOT double-subtract the ledger", () => {
    const root = freshRoot();
    const world = new FsWorld(root);
    const { plan, baseline } = damage(world);
    execute(plan, world, {});
    expect(world.snapshot().ledgerUsd).toBe(baseline.ledgerUsd); // charge 12 → refund 12 → net 0
    // a brand-new process over the same on-disk root re-runs the whole plan:
    const replay = new FsWorld(root);
    execute(plan, replay, {});
    expect(replay.snapshot().ledgerUsd).toBe(baseline.ledgerUsd); // STILL 0 — no double-refund to -12
    // and the applied markers are genuinely on disk
    expect(readdirSync(join(root, "applied")).length).toBeGreaterThan(0);
  });

  it("refuses a path that escapes the sandbox root (no traversal)", () => {
    const root = freshRoot();
    const world = new FsWorld(root);
    expect(() => world.writeFile("../../etc/escape", "nope")).toThrow(/escapes sandbox root/);
  });

  it("the SAFE executor (kill-switch / policy / journal / anti-fabrication) also works on real disk", () => {
    const root = freshRoot();
    const world = new FsWorld(root);
    const { plan, baseline } = damage(world);
    const token = computeConfirmToken(plan);
    const r = safeExecute(plan, world, { env: {} as NodeJS.ProcessEnv, confirmToken: token, policy: SANDBOX_AUTO_POLICY });
    expect(r.phase).toBe("executed");
    expect(r.fabricationCheck.pass).toBe(true); // every reported restoration is journal-confirmed
    const after = world.snapshot();
    expect(after.ledgerUsd).toBe(baseline.ledgerUsd);
    expect(Object.keys(after.rows).sort()).toEqual(Object.keys(baseline.rows).sort());
  });

  it("plan-only by default on real disk mutates NOTHING", () => {
    const root = freshRoot();
    const world = new FsWorld(root);
    const { plan } = damage(world);
    const before = world.snapshot();
    safeExecute(plan, world, { env: {} as NodeJS.ProcessEnv }); // no token, no autoConfirm
    expect(world.snapshot()).toEqual(before);
  });

  it("partial failure on real disk blocks the saga and records a resume point", () => {
    const root = freshRoot();
    const world = new FsWorld(root);
    const { plan } = damage(world);
    const firstId = plan.steps[0]!.forActionId;
    const r = execute(plan, world, { failOn: firstId });
    expect(r.failed).toBe(1);
    expect(r.resumeFrom).toBe(0);
    expect(r.blocked).toBe(plan.steps.length - 1);
  });

  // ── regressions for the pre-publish audit findings ──

  it("marker-first: a failed marker write does NOT double-refund across a replay (audit fix)", () => {
    const root = freshRoot();
    const world = new FsWorld(root);
    const { plan, baseline } = damage(world); // includes a $12 charge → ledger baseline+12
    // Make the applied-markers dir read-only so the next marker write fails. Under the OLD side-effect-
    // first ordering this committed the refund then lost the marker → a fresh replay double-refunded to
    // baseline-12. Under marker-FIRST, the throw happens before the side effect, so nothing commits.
    chmodSync(join(root, "applied"), 0o500);
    execute(plan, world, {}); // marker writes fail → caught into failed steps; saga blocks; no double-apply
    chmodSync(join(root, "applied"), 0o700); // restore perms
    // The decisive invariant (holds regardless of whether chmod blocked writes, e.g. on root):
    // replaying the whole plan on a fresh process nets the ledger to EXACTLY baseline — one refund, never -12.
    const replay = new FsWorld(root);
    execute(plan, replay, {});
    expect(replay.snapshot().ledgerUsd).toBe(baseline.ledgerUsd);
    expect(replay.snapshot().ledgerUsd).not.toBe(baseline.ledgerUsd - 12); // the double-refund bug is gone
  });

  it("seg(): a row id containing a path separator is a LOUD failure, never a silent clobber (audit fix)", () => {
    const world = new FsWorld(freshRoot());
    expect(() => world.seedRow("orders", "a/b", { x: 1 })).toThrow(/unsafe path segment/);
    expect(() => world.softDeleteRow("orders", "..")).toThrow(/unsafe path segment/);
  });

  it("readLedger(): a corrupt ledger file is surfaced, never masked as a valid $0 (audit fix)", () => {
    const root = freshRoot();
    const world = new FsWorld(root);
    world.charge("m", 5); // ledger = 5
    writeFileSync(join(root, "ledger.json"), "{ this is not json"); // corrupt it
    expect(() => world.snapshot()).toThrow(); // must NOT return a silent 0
  });

  it("sendEmail advances the action-id sequence exactly once — id parity with the in-memory World (audit fix)", () => {
    const script = (w: FsWorld | World): string[] => {
      w.seedRow("orders", "t1", { is_test: true });
      const actions = [w.writeFile("/b.bak", "x"), w.softDeleteRow("orders", "t1"), w.charge("api", 12), w.sendEmail("c@a.com", "hi"), w.dropTable("none")];
      return actions.map((a) => a.id);
    };
    const fsIds = script(new FsWorld(freshRoot()));
    const memIds = script(new World());
    expect(fsIds).toEqual(memIds); // identical op1..opN sequence — no drift from a double nextId()
  });
});
