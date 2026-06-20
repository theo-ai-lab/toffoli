import { describe, it, expect } from "vitest";
import { SqlWorld, sqlRunInverse, sqlWorldSelfCheck } from "./sql-world";
import { classifyAction } from "../engine/restitute";
import { planResumable } from "../engine/resumable";
import { safeExecute } from "../runtime/safe-executor";
import { SANDBOX_AUTO_POLICY } from "../runtime/policy";
import type { AgentAction } from "../engine/types";

// No ambient kill-switch / mode env can turn a recovery into a no-op during the test.
const noEnv = {} as NodeJS.ProcessEnv;

describe("SqlWorld — real node:sqlite recovery world", () => {
  it("passes its end-to-end inline self-check (real :memory: DB, real undo vs a baseline)", () => {
    const r = sqlWorldSelfCheck();
    // Surface the specific failing check(s) rather than a bare boolean.
    const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.name} — ${c.detail ?? ""}`);
    expect(failed).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it("recovers the recoverable subset through safeExecute + sqlRunInverse, restoring rows + ledger to baseline", async () => {
    const w = new SqlWorld(":memory:");
    try {
      w.seedTable("orders");
      w.seedRow("orders", "1001", { customer: "acme", is_test: false });
      w.seedRow("orders", "1002", { customer: "sandbox", is_test: true });
      const baseline = w.snapshot();

      // Damage: a bad soft-delete of a LIVE row + a refundable charge + an irreversible external send.
      const del = w.softDeleteRow("orders", "1001");
      const chg = w.charge("enrich-api", 9);
      const mail = w.sendEmail("finance@corp.test", "done");
      const run: AgentAction[] = [del, chg, mail];

      const classifications = await Promise.all(run.map((a) => classifyAction(a)));
      const rp = planResumable(run, classifications);
      const report = safeExecute(rp, w, {
        runInverse: sqlRunInverse, // the SQL dispatch seam (handles restore-prior; delegates the rest)
        autoConfirm: true,
        policy: SANDBOX_AUTO_POLICY, // sandbox widens auto to COMPENSABLE refunds
        mode: "sandbox",
        env: noEnv,
      });

      // 1 row restore + 1 refund auto-run; the email is escalated, never auto-undone.
      expect(report.restored).toBe(2);
      expect(report.fabricationCheck.pass).toBe(true);
      expect(report.escalations.some((e) => e.kind === "irreversible")).toBe(true);

      const after = w.snapshot();
      expect(after.rows).toEqual(baseline.rows); // the deleted live row is genuinely back
      expect(after.ledgerUsd).toBe(baseline.ledgerUsd); // refunded to net baseline
      expect(Object.keys(after.trashRows)).toHaveLength(0); // trash drained
      // Restraint: the sent email stays sent (irreversible, untouched by recovery).
      expect(after.outbox).toEqual(["finance@corp.test: done"]);
    } finally {
      w.close();
    }
  });

  it("is idempotent: replaying the recovery does not double-refund", async () => {
    const w = new SqlWorld(":memory:");
    try {
      w.seedRow("orders", "1001", { customer: "acme", is_test: false });
      const baseline = w.snapshot();
      const del = w.softDeleteRow("orders", "1001");
      const chg = w.charge("api", 9);
      const run = [del, chg];

      const classifications = await Promise.all(run.map((a) => classifyAction(a)));
      const rp = planResumable(run, classifications);
      const opts = {
        runInverse: sqlRunInverse,
        autoConfirm: true,
        policy: SANDBOX_AUTO_POLICY,
        mode: "sandbox" as const,
        env: noEnv,
      };
      const r1 = safeExecute(rp, w, opts);
      const r2 = safeExecute(rp, w, opts); // replay on already-recovered state

      expect(r1.restored).toBe(2);
      expect(r2.fabricationCheck.pass).toBe(true); // a replay is a success-skip, not a fabricated restore
      expect(w.snapshot().ledgerUsd).toBe(baseline.ledgerUsd); // NOT double-refunded
    } finally {
      w.close();
    }
  });

  it("reverts a destructive UPDATE via restore-prior, and leaves a no-backup DROP unsupported (escalated)", () => {
    const w = new SqlWorld(":memory:");
    try {
      w.seedRow("users", "1", { name: "Ada", tier: "free" });
      const upd = w.updateRow("users", "1", { name: "Ada", tier: "WIPED" });
      const revert = sqlRunInverse(
        "restore-prior",
        { id: upd.target?.id, to: upd.target?.priorState },
        `restitution:${upd.id}:restore-prior`,
        w,
      );
      expect(revert.status).toBe("restored");
      expect((w.snapshot().rows["users:1"] as { tier: string }).tier).toBe("free");

      w.seedTable("logs");
      w.dropTable("logs"); // destroyed with no backup
      const drop = sqlRunInverse("restore-from-backup", { id: "logs" }, "restitution:drop:restore-from-backup", w);
      expect(drop.status).toBe("unsupported"); // never fabricated back — must reach a human
    } finally {
      w.close();
    }
  });
});
