/**
 * The circuit breaker is a safety primitive with no direct test until now.
 *
 * That matters more than a coverage number: a breaker that never OPENS looks identical, in a healthy
 * run, to one that works. It only differs when a dependency is already failing — which is the one
 * moment nobody is watching. The same shape as an anti-fabrication check that only ever sees honest
 * executors, or a drill whose control passes because the verifier agrees with itself.
 *
 * The clock is injected, so every transition here is asserted deterministically rather than slept
 * through.
 */
import { describe, it, expect } from "vitest";
import { CircuitBreaker, RetryBudget, backoffDelay, isTransient, DEFAULT_BACKOFF } from "./resilience";

/** A hand-cranked clock: time only moves when a test says so. */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const CFG = { failureThreshold: 3, openMs: 30_000, halfOpenProbes: 2 };

describe("CircuitBreaker — closed until the failures are consecutive", () => {
  it("stays closed below the threshold", () => {
    const b = new CircuitBreaker(CFG, clock().now);
    b.onFailure();
    b.onFailure();
    expect(b.current()).toBe("closed");
    expect(b.canAttempt()).toBe(true);
  });

  it("a success RESETS the run, so scattered failures never trip it", () => {
    const b = new CircuitBreaker(CFG, clock().now);
    b.onFailure();
    b.onFailure();
    b.onSuccess(); // the run is broken here
    b.onFailure();
    b.onFailure();
    expect(b.current()).toBe("closed");
  });

  it("opens on the threshold and then refuses traffic", () => {
    const b = new CircuitBreaker(CFG, clock().now);
    for (let i = 0; i < 3; i++) b.onFailure();
    expect(b.current()).toBe("open");
    expect(b.canAttempt()).toBe(false);
  });
});

describe("CircuitBreaker — the cooldown probe", () => {
  it("stays shut until the cooldown has fully elapsed", () => {
    const c = clock();
    const b = new CircuitBreaker(CFG, c.now);
    for (let i = 0; i < 3; i++) b.onFailure();

    c.advance(29_999);
    expect(b.canAttempt()).toBe(false);
    expect(b.current()).toBe("open");
  });

  it("admits exactly ONE probe on cooldown, so a wedged backend is not hammered by a burst", () => {
    const c = clock();
    const b = new CircuitBreaker(CFG, c.now);
    for (let i = 0; i < 3; i++) b.onFailure();
    c.advance(30_000);

    expect(b.canAttempt()).toBe(true); // the probe
    expect(b.current()).toBe("half-open");
    expect(b.canAttempt()).toBe(false); // a concurrent caller is denied
    expect(b.canAttempt()).toBe(false);
  });

  it("closes only after the configured number of successful probes", () => {
    const c = clock();
    const b = new CircuitBreaker(CFG, c.now);
    for (let i = 0; i < 3; i++) b.onFailure();
    c.advance(30_000);

    b.canAttempt();
    b.onSuccess();
    expect(b.current()).toBe("half-open"); // one is not enough

    b.canAttempt();
    b.onSuccess();
    expect(b.current()).toBe("closed");
  });

  it("a FAILED probe re-opens immediately, restarting the cooldown", () => {
    const c = clock();
    const b = new CircuitBreaker(CFG, c.now);
    for (let i = 0; i < 3; i++) b.onFailure();
    c.advance(30_000);

    b.canAttempt();
    b.onFailure();
    expect(b.current()).toBe("open");
    expect(b.canAttempt()).toBe(false); // the clock restarted; no immediate second probe
  });

  it("abandonProbe releases the slot without scoring the backend, so the breaker cannot wedge", () => {
    const c = clock();
    const b = new CircuitBreaker(CFG, c.now);
    for (let i = 0; i < 3; i++) b.onFailure();
    c.advance(30_000);

    b.canAttempt();
    b.abandonProbe(); // e.g. the method had no adapter: not the backend's fault, not its credit

    expect(b.current()).toBe("half-open");
    expect(b.canAttempt()).toBe(true); // without this the probe stays in flight forever
  });
});

describe("RetryBudget — bounded, and shared across calls", () => {
  it("hands out attempts until it is exhausted", () => {
    const budget = new RetryBudget(2);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(false);
    expect(budget.available()).toBe(0);
  });

  it("a zero budget permits no retry at all", () => {
    expect(new RetryBudget(0).tryAcquire()).toBe(false);
  });

  it("refills on success, but only in fractions — one good call does not restore a whole retry", () => {
    const budget = new RetryBudget(1, 0.1);
    expect(budget.tryAcquire()).toBe(true);
    budget.onSuccess();
    // 0.1 tokens is not 1 token: a flapping dependency cannot mint retry budget by succeeding
    // occasionally, which is the failure mode a whole-token refill would allow.
    expect(budget.tryAcquire()).toBe(false);
  });

  it("never refills past its ceiling", () => {
    const budget = new RetryBudget(2, 0.5);
    for (let i = 0; i < 20; i++) budget.onSuccess();
    expect(budget.available()).toBe(2);
  });
});

describe("backoffDelay — bounded and jittered", () => {
  it("never exceeds maxMs however many attempts have happened", () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      expect(backoffDelay(attempt, DEFAULT_BACKOFF, () => 1)).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs);
    }
  });

  it("is never negative, even with the jitter at its floor", () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      expect(backoffDelay(attempt, DEFAULT_BACKOFF, () => 0)).toBeGreaterThanOrEqual(0);
    }
  });

  it("grows with the attempt number", () => {
    const fixed = () => 1;
    expect(backoffDelay(2, DEFAULT_BACKOFF, fixed)).toBeGreaterThan(backoffDelay(0, DEFAULT_BACKOFF, fixed));
  });
});

describe("isTransient", () => {
  it("does not treat a plain programmer error as retryable", () => {
    expect(isTransient(new TypeError("undefined is not a function"))).toBe(false);
  });

  it("does not treat a non-error value as retryable", () => {
    expect(isTransient("boom")).toBe(false);
    expect(isTransient(null)).toBe(false);
  });
});
