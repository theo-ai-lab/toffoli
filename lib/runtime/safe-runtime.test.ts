/**
 * Toffoli — tests for the safe runtime executor and its safety primitives.
 *
 * These pin the deploy-critical invariants: the kill-switch is enforced, plan-only is the default,
 * the confirm token is plan-bound, COMPENSATION-FAILED never silently drops, the saga blocks past a
 * failure, and — the anti-Replit invariant — no "restored" is reported without a durable journal
 * confirmation.
 */

import { describe, it, expect } from "vitest";
import { buildRecoveryCase } from "../exec/recover";
import type { RecoveryWorld } from "../exec/world";
import { dispatchInverse, type InverseOutcome } from "../exec/executor";
import { safeExecute, computeConfirmToken } from "./safe-executor";
import { DEFAULT_AUTO_POLICY, SANDBOX_AUTO_POLICY, decideAuto } from "./policy";
import { effectiveMode, KILL_SWITCH_ENV } from "./mode";
import { InMemoryJournal, type StepJournal, type IntentRecord } from "./journal";
import { InMemorySink, type EscalationSink } from "./escalation";
import { CircuitBreaker, BreakerRegistry, RetryBudget, backoffDelay, isTransient, withRetrySync } from "./resilience";

const fixedClock = () => "2026-06-06T00:00:00Z";
const sandboxOpts = { clock: fixedClock, env: {} as NodeJS.ProcessEnv };

describe("execution mode + kill-switch (the chokepoint)", () => {
  it("defaults to sandbox, never execute", () => {
    expect(effectiveMode(undefined, {}).effective).toBe("sandbox");
  });
  it("the kill-switch forces dry-run regardless of the requested mode", () => {
    const d = effectiveMode("execute", { [KILL_SWITCH_ENV]: "1" } as NodeJS.ProcessEnv);
    expect(d.effective).toBe("dry-run");
    expect(d.killSwitchEngaged).toBe(true);
  });
  it("treats 0/false as NOT engaged (no accidental freeze)", () => {
    expect(effectiveMode("execute", { [KILL_SWITCH_ENV]: "0" } as NodeJS.ProcessEnv).killSwitchEngaged).toBe(false);
    expect(effectiveMode("execute", { [KILL_SWITCH_ENV]: "false" } as NodeJS.ProcessEnv).killSwitchEngaged).toBe(false);
  });
});

describe("plan-only by default", () => {
  it("with no token and no autoConfirm, mutates NOTHING and stays plan-only", () => {
    const { world, plan } = buildRecoveryCase();
    const before = world.snapshot();
    const r = safeExecute(plan, world, sandboxOpts);
    expect(r.phase).toBe("plan-only");
    expect(r.restored).toBe(0);
    expect(world.snapshot()).toEqual(before); // zero mutation
    expect(r.steps.every((s) => s.status === "planned")).toBe(true);
  });

  it("still escalates the irreversible remainder to a human, even in plan-only", () => {
    const { world, plan } = buildRecoveryCase();
    const sink = new InMemorySink();
    safeExecute(plan, world, { ...sandboxOpts, sink });
    const irreversible = sink.records.filter((e) => e.kind === "irreversible");
    expect(irreversible.length).toBeGreaterThanOrEqual(2); // dropped table + sent email
  });

  it("the kill-switch keeps it plan-only even when a valid token is presented", () => {
    const { world, plan } = buildRecoveryCase();
    const token = computeConfirmToken(plan);
    const before = world.snapshot();
    const r = safeExecute(plan, world, { clock: fixedClock, env: { [KILL_SWITCH_ENV]: "1" } as NodeJS.ProcessEnv, confirmToken: token, policy: SANDBOX_AUTO_POLICY });
    expect(r.mode.killSwitchEngaged).toBe(true);
    expect(r.phase).toBe("plan-only");
    expect(world.snapshot()).toEqual(before);
  });
});

describe("confirm-token gate", () => {
  it("a valid plan-bound token authorizes executing the whole plan", () => {
    const { world, plan, baseline } = buildRecoveryCase();
    const token = computeConfirmToken(plan);
    const r = safeExecute(plan, world, { ...sandboxOpts, confirmToken: token, policy: SANDBOX_AUTO_POLICY });
    expect(r.phase).toBe("executed");
    // restores the recoverable subset to baseline (files + rows + ledger)
    const after = world.snapshot();
    expect(after.files).toEqual(baseline.files);
    expect(after.rows).toEqual(baseline.rows);
    expect(after.ledgerUsd).toBe(baseline.ledgerUsd);
    expect(r.restored).toBe(plan.steps.length);
  });

  it("a wrong/stale token is refused: stays plan-only and escalates", () => {
    const { world, plan } = buildRecoveryCase();
    const before = world.snapshot();
    const sink = new InMemorySink();
    const r = safeExecute(plan, world, { ...sandboxOpts, sink, confirmToken: "deadbeef", policy: SANDBOX_AUTO_POLICY });
    expect(r.phase).toBe("plan-only");
    expect(world.snapshot()).toEqual(before);
    expect(sink.records.some((e) => e.kind === "confirm-required" && e.forActionId === "*plan*")).toBe(true);
  });
});

describe("autoConfirm autonomy is policy-bounded (judge can only lower autonomy)", () => {
  it("DEFAULT policy auto-runs only REVERSIBLE exact inverses; COMPENSABLE refund escalates for confirm", () => {
    const { world, plan } = buildRecoveryCase();
    const sink = new InMemorySink();
    const r = safeExecute(plan, world, { ...sandboxOpts, sink, autoConfirm: true, policy: DEFAULT_AUTO_POLICY });
    expect(r.phase).toBe("executed");
    // the refund (COMPENSABLE) must be held for confirmation, not auto-run
    const confirmReq = r.steps.filter((s) => s.status === "confirm-required");
    expect(confirmReq.some((s) => s.method === "refund")).toBe(true);
    expect(sink.records.some((e) => e.kind === "confirm-required" && e.method === "refund")).toBe(true);
    // the exact reversals still ran
    expect(r.restored).toBeGreaterThanOrEqual(1);
    expect(r.steps.filter((s) => s.status === "restored").every((s) => s.method === "delete" || s.method === "restore")).toBe(true);
  });

  it("SANDBOX policy auto-runs the COMPENSABLE refund too — parity with the bare executor", () => {
    const { world, plan } = buildRecoveryCase();
    const r = safeExecute(plan, world, { ...sandboxOpts, autoConfirm: true, policy: SANDBOX_AUTO_POLICY });
    expect(r.restored).toBe(plan.steps.length);
    expect(r.fabricationCheck.pass).toBe(true);
  });
});

describe("COMPENSATION-FAILED is a real runtime state, never a silent drop", () => {
  it("a failed compensation is escalated, blocks the saga, and reports compensation-failed", () => {
    const { world, plan } = buildRecoveryCase();
    const sink = new InMemorySink();
    // force the FIRST step's inverse to fail terminally (permanent)
    const firstActionId = plan.steps[0]!.forActionId;
    const runInverse = (_method: string, _params: Record<string, unknown> | undefined, idem: string, _w: RecoveryWorld): InverseOutcome => {
      const forFirst = plan.steps.find((s) => s.compensation.idempotencyKey === idem)?.forActionId === firstActionId;
      if (forFirst) return { status: "failed", detail: "injected permanent failure" };
      // default behavior for the rest (won't be reached — saga blocks)
      return { status: "restored", detail: "ok" };
    };
    const r = safeExecute(plan, world, { ...sandboxOpts, sink, autoConfirm: true, policy: SANDBOX_AUTO_POLICY, runInverse });
    expect(r.compensationFailed).toBe(1);
    expect(r.steps.filter((s) => s.status === "blocked").length).toBe(plan.steps.length - 1); // rest blocked
    expect(sink.records.some((e) => e.kind === "compensation-failed")).toBe(true);
    expect(sink.records.some((e) => e.kind === "blocked")).toBe(true);
  });
});

describe("the anti-fabrication invariant (defends against the Replit failure mode)", () => {
  it("a 'restored' that the journal did NOT confirm fails the fabrication check", () => {
    const { world, plan } = buildRecoveryCase();
    // a journal whose durable write silently fails: intent is recorded, but complete() is dropped,
    // so confirms() stays false — modeling a successful side effect with a lost audit write.
    class LossyJournal extends InMemoryJournal {
      override complete(): void {
        /* dropped: the durable write failed */
      }
    }
    const journal: StepJournal = new LossyJournal(fixedClock);
    const r = safeExecute(plan, world, { ...sandboxOpts, autoConfirm: true, policy: SANDBOX_AUTO_POLICY, journal });
    // the inverse succeeded so steps report restored, but none is journal-confirmed → fabrication caught
    expect(r.steps.some((s) => s.status === "restored")).toBe(true);
    expect(r.steps.every((s) => s.status !== "restored" || s.journalConfirmed === false)).toBe(true);
    expect(r.fabricationCheck.pass).toBe(false);
  });

  it("the honest path passes the fabrication check (every restored is journal-confirmed)", () => {
    const { world, plan } = buildRecoveryCase();
    const r = safeExecute(plan, world, { ...sandboxOpts, autoConfirm: true, policy: SANDBOX_AUTO_POLICY });
    expect(r.fabricationCheck.pass).toBe(true);
    expect(r.steps.filter((s) => s.status === "restored").every((s) => s.journalConfirmed)).toBe(true);
  });
});

describe("circuit breaker: skip a wedged backend, escalate, don't hammer", () => {
  it("an already-open breaker defers the step as breaker-open and escalates", () => {
    const { world, plan } = buildRecoveryCase();
    const breakers = new BreakerRegistry({ failureThreshold: 1, openMs: 60_000, halfOpenProbes: 1 }, () => 0);
    breakers.for("store").onFailure(); // trip the store breaker open
    const sink = new InMemorySink();
    const r = safeExecute(plan, world, { ...sandboxOpts, sink, autoConfirm: true, policy: SANDBOX_AUTO_POLICY, breakers });
    expect(r.steps.some((s) => s.status === "breaker-open")).toBe(true);
    expect(sink.records.some((e) => e.kind === "compensation-failed" && /circuit/.test(e.reason))).toBe(true);
  });
});

describe("WAL journal", () => {
  it("intend → complete records DONE and confirms; pending() empties", () => {
    const j = new InMemoryJournal(fixedClock);
    const rec: IntentRecord = { idemKey: "k1", forActionId: "a1", method: "restore" };
    j.intend(rec);
    expect(j.pending().length).toBe(1);
    expect(j.confirms("k1")).toBe(false);
    j.complete("k1", "restored a1", 1);
    expect(j.confirms("k1")).toBe(true);
    expect(j.pending().length).toBe(0);
  });

  it("crash-replay: re-intending a resolved key keeps its DONE status (idempotent redo)", () => {
    const j = new InMemoryJournal(fixedClock);
    j.intend({ idemKey: "k1", forActionId: "a1", method: "restore" });
    j.complete("k1", "ok", 1);
    j.intend({ idemKey: "k1", forActionId: "a1", method: "restore" }); // replay after crash
    expect(j.confirms("k1")).toBe(true);
    expect(j.entries().length).toBe(1);
  });

  it("serialize/load round-trips for durable storage", () => {
    const j = new InMemoryJournal(fixedClock);
    j.intend({ idemKey: "k1", forActionId: "a1", method: "restore" });
    j.complete("k1", "ok", 1);
    const restored = InMemoryJournal.load(j.serialize(), fixedClock);
    expect(restored.confirms("k1")).toBe(true);
  });
});

describe("resilience primitives", () => {
  it("isTransient: retry locks/5xx/timeouts; never permission/validation/4xx", () => {
    expect(isTransient(new Error("ETIMEDOUT"))).toBe(true);
    expect(isTransient(new Error("deadlock detected"))).toBe(true);
    expect(isTransient({ status: 503 })).toBe(true);
    expect(isTransient({ status: 429 })).toBe(true);
    expect(isTransient(new Error("permission denied"))).toBe(false);
    expect(isTransient(new Error("validation failed"))).toBe(false);
    expect(isTransient({ status: 403 })).toBe(false);
    expect(isTransient({ status: 404 })).toBe(false);
  });

  it("backoffDelay is capped and within [0, ceil] (full jitter)", () => {
    const cfg = { baseMs: 100, maxMs: 1000, maxRetries: 5 };
    expect(backoffDelay(0, cfg, () => 1)).toBe(100); // base·2^0
    expect(backoffDelay(3, cfg, () => 1)).toBe(800); // base·2^3
    expect(backoffDelay(10, cfg, () => 1)).toBe(1000); // capped at maxMs
    expect(backoffDelay(3, cfg, () => 0)).toBe(0); // full jitter floor
  });

  it("withRetrySync retries only transient faults, up to the bound, then fails", () => {
    let calls = 0;
    const r = withRetrySync(
      () => {
        calls++;
        if (calls < 3) throw new Error("ETIMEDOUT");
        return "ok";
      },
      { backoff: { baseMs: 1, maxMs: 1, maxRetries: 5 }, rng: () => 0 },
    );
    expect(r.ok).toBe(true);
    expect(r.value).toBe("ok");
    expect(calls).toBe(3);
  });

  it("withRetrySync does NOT retry a permanent fault", () => {
    let calls = 0;
    const r = withRetrySync(
      () => {
        calls++;
        throw new Error("permission denied");
      },
      { backoff: { baseMs: 1, maxMs: 1, maxRetries: 5 }, rng: () => 0 },
    );
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it("circuit breaker: opens after threshold, half-opens after cooldown, closes on probe success", () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 2, openMs: 100, halfOpenProbes: 1 }, () => t);
    expect(b.canAttempt()).toBe(true);
    b.onFailure();
    b.onFailure(); // trips open
    expect(b.current()).toBe("open");
    expect(b.canAttempt()).toBe(false); // still within cooldown
    t = 100; // cooldown elapsed
    expect(b.canAttempt()).toBe(true); // half-open probe allowed
    expect(b.current()).toBe("half-open");
    b.onSuccess();
    expect(b.current()).toBe("closed");
  });

  it("retry budget exhausts and refills", () => {
    const budget = new RetryBudget(2, 0.5);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(false); // empty
    budget.onSuccess();
    budget.onSuccess(); // +1.0 → 1 token
    expect(budget.tryAcquire()).toBe(true);
  });
});

describe("policy gate (class × confidence × allowlist)", () => {
  const cls = (over: Partial<import("../engine/types").Classification>): import("../engine/types").Classification => ({
    actionId: "a",
    class: "REVERSIBLE",
    idempotent: false,
    confidence: 1,
    llmAssisted: false,
    ruleRef: "test",
    rationale: "test",
    ...over,
  });
  const comp = (method: string): import("../engine/types").CompensatingAction => ({ forActionId: "a", method, idempotencyKey: "k", restoration: "exact", rationale: "r" });

  it("IRREVERSIBLE never auto-executes (floor)", () => {
    expect(decideAuto(cls({ class: "IRREVERSIBLE" }), comp("delete")).auto).toBe(false);
  });
  it("low confidence blocks auto-execution", () => {
    expect(decideAuto(cls({ confidence: 0.5 }), comp("delete")).auto).toBe(false);
  });
  it("a judge-assisted verdict never auto-executes by default (judge can't grant autonomy)", () => {
    expect(decideAuto(cls({ llmAssisted: true }), comp("delete")).auto).toBe(false);
  });
  it("a method outside the default-deny allowlist is blocked", () => {
    expect(decideAuto(cls({}), comp("nuke")).auto).toBe(false);
  });
  it("a high-confidence deterministic REVERSIBLE exact inverse passes", () => {
    expect(decideAuto(cls({}), comp("delete")).auto).toBe(true);
  });
  it("COMPENSABLE is blocked under DEFAULT but allowed under SANDBOX", () => {
    expect(decideAuto(cls({ class: "COMPENSABLE" }), comp("refund"), DEFAULT_AUTO_POLICY).auto).toBe(false);
    expect(decideAuto(cls({ class: "COMPENSABLE" }), comp("refund"), SANDBOX_AUTO_POLICY).auto).toBe(true);
  });
  it("an out-of-range or non-finite confidence is blocked (never auto-execute on a malformed verdict)", () => {
    expect(decideAuto(cls({ confidence: 1.5 }), comp("delete")).auto).toBe(false);
    expect(decideAuto(cls({ confidence: -0.1 }), comp("delete")).auto).toBe(false);
    expect(decideAuto(cls({ confidence: NaN }), comp("delete")).auto).toBe(false);
  });
});

// ── regressions for the pre-publish audit findings ──────────────────────────────

describe("escalation delivery is failure-visible and never process-fatal (audit fix)", () => {
  it("an async sink that REJECTS is caught (no unhandledRejection), the record is preserved, and the failure is surfaced", async () => {
    const rejectingSink: EscalationSink = { emit: () => Promise.reject(new Error("webhook 503")) };
    const { world, plan } = buildRecoveryCase();
    const surfaced: string[] = [];
    let unhandled = false;
    const onUnhandled = (): void => {
      unhandled = true;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      // plan-only still escalates the irreversible remainder through the rejecting sink
      const r = safeExecute(plan, world, { ...sandboxOpts, sink: rejectingSink, onDeliveryFailure: (rec) => surfaced.push(rec.forActionId) });
      expect(r.escalations.length).toBeGreaterThanOrEqual(2); // records preserved in the report regardless of transport
      await new Promise((res) => setTimeout(res, 15)); // let the rejected promises settle
      expect(unhandled).toBe(false); // the .catch() prevented an unhandledRejection (would crash Node otherwise)
      expect(surfaced.length).toBeGreaterThanOrEqual(2); // every failed delivery was surfaced, not silently dropped
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a synchronously-throwing sink is caught and surfaced, not propagated", () => {
    const throwingSink: EscalationSink = {
      emit: () => {
        throw new Error("sync sink boom");
      },
    };
    const { world, plan } = buildRecoveryCase();
    const surfaced: string[] = [];
    expect(() => safeExecute(plan, world, { ...sandboxOpts, sink: throwingSink, onDeliveryFailure: (rec) => surfaced.push(rec.forActionId) })).not.toThrow();
    expect(surfaced.length).toBeGreaterThanOrEqual(2);
  });
});

describe("bounded transient-retry is reachable through the inverse-outcome path (audit fix)", () => {
  it("a failed outcome carrying a TRANSIENT error is retried, then succeeds", () => {
    const { world, plan } = buildRecoveryCase();
    const firstId = plan.steps[0]!.forActionId;
    const idemOf = (id: string) => plan.steps.find((s) => s.forActionId === id)!.compensation.idempotencyKey;
    let calls = 0;
    const runInverse = (method: string, params: Record<string, unknown> | undefined, idem: string, w: RecoveryWorld): InverseOutcome => {
      if (idem === idemOf(firstId)) {
        calls += 1;
        if (calls < 3) return { status: "failed", detail: "ETIMEDOUT — transient lock contention", error: new Error("ETIMEDOUT") };
        return { status: "restored", detail: "ok after retry" };
      }
      return dispatchInverse(method, params, idem, w);
    };
    const r = safeExecute(plan, world, { ...sandboxOpts, autoConfirm: true, policy: SANDBOX_AUTO_POLICY, runInverse, backoff: { baseMs: 1, maxMs: 1, maxRetries: 5 }, rng: () => 0 });
    expect(calls).toBe(3); // retried twice, then restored
    expect(r.steps.find((s) => s.forActionId === firstId)?.status).toBe("restored");
  });

  it("a failed outcome carrying a PERMANENT error is NOT retried", () => {
    const { world, plan } = buildRecoveryCase();
    const firstId = plan.steps[0]!.forActionId;
    const idemOf = (id: string) => plan.steps.find((s) => s.forActionId === id)!.compensation.idempotencyKey;
    let calls = 0;
    const runInverse = (method: string, params: Record<string, unknown> | undefined, idem: string, w: RecoveryWorld): InverseOutcome => {
      if (idem === idemOf(firstId)) {
        calls += 1;
        return { status: "failed", detail: "permission denied", error: new Error("permission denied") };
      }
      return dispatchInverse(method, params, idem, w);
    };
    const r = safeExecute(plan, world, { ...sandboxOpts, autoConfirm: true, policy: SANDBOX_AUTO_POLICY, runInverse, backoff: { baseMs: 1, maxMs: 1, maxRetries: 5 }, rng: () => 0 });
    expect(calls).toBe(1); // permanent → exactly one attempt
    expect(r.steps.find((s) => s.forActionId === firstId)?.status).toBe("compensation-failed");
  });
});

describe("anti-fabrication requires the intend→done lineage (audit fix)", () => {
  it("a complete() with no preceding intend() does NOT confirm", () => {
    const j = new InMemoryJournal(fixedClock);
    j.complete("orphan", "done without a prior intent", 1); // WAL-ordering violation
    expect(j.confirms("orphan")).toBe(false);
    j.intend({ idemKey: "k", forActionId: "a", method: "restore" });
    j.complete("k", "ok", 1);
    expect(j.confirms("k")).toBe(true); // proper lineage confirms
  });
});

describe("circuit breaker admits at most one half-open probe (audit fix)", () => {
  it("a second concurrent probe in half-open is denied until the first resolves", () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, openMs: 100, halfOpenProbes: 2 }, () => t);
    b.onFailure(); // trips open
    t = 100; // cooldown elapsed
    expect(b.canAttempt()).toBe(true); // the single cooldown probe
    expect(b.canAttempt()).toBe(false); // a second concurrent probe is denied
    b.onSuccess(); // the outstanding probe resolves
    expect(b.canAttempt()).toBe(true); // now the next probe is admitted
  });
});

describe("circuit breaker does not wedge when a half-open probe is unsupported (audit fix)", () => {
  it("abandonProbe releases the half-open slot without a success/failure, so the breaker can't get stuck", () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, openMs: 100, halfOpenProbes: 1 }, () => t);
    b.onFailure(); // trips open
    t = 100; // cooldown elapsed
    expect(b.canAttempt()).toBe(true); // the single cooldown probe is admitted
    expect(b.current()).toBe("half-open");
    // the probe resolved on a NON-backend outcome (the method is "unsupported") — neither success nor failure.
    b.abandonProbe();
    expect(b.current()).toBe("half-open"); // unchanged: no success counted, no re-trip
    // pre-fix the probe stayed in flight forever and this returned false (wedged); now the next probe is admitted.
    expect(b.canAttempt()).toBe(true);
  });
});
