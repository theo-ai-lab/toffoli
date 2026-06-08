import { describe, it, expect } from "vitest";
import { recoveryScenario, buildRecoveryCase } from "./recover";
import { execute } from "./executor";

describe("end-to-end recovery on sandboxed state", () => {
  it("restores every recoverable action and leaves the irreversible ones untouched (verified restraint)", () => {
    const r = recoveryScenario();
    expect(r.totals.recoverable).toBe(4);
    expect(r.totals.irreversible).toBe(2);
    expect(r.result.restored).toBe(4);
    expect(r.result.failed).toBe(0);
    expect(r.recoverableRestored).toBe(true); // recoverable subset == pre-damage (file contents, rows, ledger net)
    expect(r.irreversibleUntouched).toBe(true); // executor did NOT change tables/outbox during recovery
    expect(r.result.escalated).toBe(2);
  });

  it("is a resumable saga: a failed compensation blocks the rest and records a resume point", () => {
    const r = recoveryScenario("op4"); // op4 = the charge; its refund runs first in undo order
    expect(r.result.failed).toBe(1);
    expect(r.result.blocked).toBeGreaterThan(0);
    expect(r.result.resumeFrom).not.toBeNull();
    expect(r.recoverableRestored).toBe(false); // a half-run recovery does not claim success
  });

  it("is GENUINELY idempotent: re-running the plan does not double-apply (no double-refund, no spurious failures)", () => {
    const { world, plan } = buildRecoveryCase();
    const r1 = execute(plan, world);
    const ledgerAfter1 = world.snapshot().ledgerUsd;
    const r2 = execute(plan, world); // replay on already-recovered state
    const ledgerAfter2 = world.snapshot().ledgerUsd;
    expect(r1.restored).toBe(4);
    expect(r2.failed).toBe(0); // replay is a success-skip, not a failure
    expect(r2.blocked).toBe(0);
    expect(ledgerAfter2).toBe(ledgerAfter1); // NOT double-refunded
  });
});
