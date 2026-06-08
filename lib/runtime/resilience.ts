/**
 * Toffoli — runtime resilience primitives (bounded retry · circuit breaker · timeout).
 *
 * An unattended, agent-called recovery service fails in exactly the ways distributed systems
 * always fail: transient locks, a wedged backend, a slow dependency. Naive handling turns a blip
 * into an outage (AWS Builders' Library: 3 retries × 5 layers = 243× downstream load). These are
 * the standard defenses, sized for Toffoli's serverless target:
 *
 *  - RETRY only TRANSIENT failures (locks, transient network, 408/429/503) — NEVER a
 *    permission-denied or a validation error (retrying those just amplifies a permanent failure).
 *    Single layer, capped exponential backoff, full jitter, bounded attempts, optional token budget.
 *  - CIRCUIT-BREAK per backend: after N consecutive failures, OPEN for a cooldown so a wedged
 *    dependency stops taking traffic; a half-open probe re-closes it. Degrade, don't wedge.
 *  - TIMEOUT every outbound call (covers DNS/TLS/connect), sized off the downstream p99.
 *
 * The sandbox world is synchronous, so the retry loop here is synchronous: the backoff DELAY is
 * computed (and surfaced for telemetry) but a sandbox replay is instantaneous. A real async adapter
 * awaits `backoffDelay(...)` between attempts — `withRetryAsync`/`withTimeout` are provided for it.
 * `backoffDelay`, the breaker, and the transient test are pure/clock-injectable so they are tested
 * deterministically (no Date.now / Math.random reaches the assertions).
 *
 * Zero dependencies.
 */

// ── transient vs permanent ────────────────────────────────────────────────────

/** HTTP statuses that are safe to retry — transient by definition. */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Substrings that mark an error as transient (lock contention, transient network). */
const TRANSIENT_HINTS = ["etimedout", "econnreset", "econnrefused", "eai_again", "socket hang up", "timeout", "timed out", "deadlock", "lock", "temporarily", "throttle", "rate limit", "503", "429"];
/** Substrings that mark an error as PERMANENT — never retried even if it looks transient. */
const PERMANENT_HINTS = ["permission", "forbidden", "unauthorized", "validation", "invalid", "not found", "schema", "constraint", "400", "401", "403", "404", "422"];

/** Heuristic transient-error classifier. Permanent hints win ties: when unsure, do NOT retry. */
export function isTransient(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") {
    if (TRANSIENT_STATUS.has(status)) return true;
    if (status >= 400 && status < 500) return false; // 4xx (except the transient set above) is permanent
  }
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (PERMANENT_HINTS.some((h) => msg.includes(h))) return false;
  return TRANSIENT_HINTS.some((h) => msg.includes(h));
}

// ── backoff ───────────────────────────────────────────────────────────────────

export interface BackoffConfig {
  /** First retry's base delay, ms. */
  baseMs: number;
  /** Hard cap on any single delay, ms. */
  maxMs: number;
  /** Max retries AFTER the first attempt (so total tries = maxRetries + 1). */
  maxRetries: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 100, maxMs: 5_000, maxRetries: 3 };

/**
 * Capped exponential backoff with FULL jitter: `random(0, min(maxMs, base·2^attempt))`.
 * Full jitter (AWS "Exponential Backoff And Jitter") avoids retry thundering-herds. `attempt` is
 * 0-based (the delay BEFORE retry #1 uses attempt=0). `rng` is injectable for deterministic tests.
 */
export function backoffDelay(attempt: number, cfg: BackoffConfig = DEFAULT_BACKOFF, rng: () => number = Math.random): number {
  const ceil = Math.min(cfg.maxMs, cfg.baseMs * 2 ** attempt);
  return Math.floor(rng() * ceil);
}

// ── token-bucket retry budget ─────────────────────────────────────────────────

/**
 * A shared retry budget so a storm of failures can't multiply load without bound. Each retry
 * spends one token; tokens refill as successful (non-retry) calls complete. ~10–20% budget is the
 * AWS recommendation — `refillPerSuccess: 0.1` ≈ 10%.
 */
export class RetryBudget {
  private tokens: number;
  constructor(private readonly max: number = 10, private readonly refillPerSuccess: number = 0.1) {
    this.tokens = max;
  }
  tryAcquire(): boolean {
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
  onSuccess(): void {
    this.tokens = Math.min(this.max, this.tokens + this.refillPerSuccess);
  }
  available(): number {
    return Math.floor(this.tokens);
  }
}

// ── circuit breaker ───────────────────────────────────────────────────────────

export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerConfig {
  /** Consecutive failures that trip the breaker OPEN. */
  failureThreshold: number;
  /** How long the breaker stays OPEN before allowing a half-open probe, ms. */
  openMs: number;
  /** Successful probes required in half-open before closing again. */
  halfOpenProbes: number;
}

// Illustrative defaults — tune per backend, not a quoted industry standard.
export const DEFAULT_BREAKER: BreakerConfig = { failureThreshold: 3, openMs: 30_000, halfOpenProbes: 2 };

/**
 * A per-backend circuit breaker. When a dependency is failing, stop sending it traffic (OPEN) and
 * let everything else proceed — degrade, don't wedge. Clock is injected so tests are deterministic.
 */
export class CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeSuccesses = 0;
  private probeInFlight = false;

  constructor(
    private readonly cfg: BreakerConfig = DEFAULT_BREAKER,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * True iff a call may be attempted right now. Side-effects: transitions OPEN→half-open on cooldown,
   * and in half-open admits AT MOST ONE probe at a time (a second concurrent caller is denied until the
   * outstanding probe resolves via onSuccess/onFailure) — so a wedged backend isn't hammered by a burst.
   */
  canAttempt(): boolean {
    if (this.state === "open") {
      if (this.now() - this.openedAt >= this.cfg.openMs) {
        this.state = "half-open";
        this.probeSuccesses = 0;
        this.probeInFlight = true;
        return true; // the single cooldown probe
      }
      return false;
    }
    if (this.state === "half-open") {
      if (this.probeInFlight) return false; // a probe is already outstanding — deny concurrent probes
      this.probeInFlight = true;
      return true;
    }
    return true; // closed
  }

  onSuccess(): void {
    if (this.state === "half-open") {
      this.probeInFlight = false;
      this.probeSuccesses += 1;
      if (this.probeSuccesses >= this.cfg.halfOpenProbes) this.close();
    } else {
      this.consecutiveFailures = 0;
    }
  }

  onFailure(): void {
    if (this.state === "half-open") {
      this.trip();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.cfg.failureThreshold) this.trip();
  }

  /**
   * Release a half-open probe slot WITHOUT counting it as a backend success or failure — for a probe
   * that resolved on a non-backend outcome (e.g. the method has no adapter and is "unsupported"). Without
   * this the probe stays in flight forever and the breaker wedges half-open, never admitting another probe.
   */
  abandonProbe(): void {
    if (this.state === "half-open") this.probeInFlight = false;
  }

  current(): BreakerState {
    return this.state;
  }

  private trip(): void {
    this.state = "open";
    this.openedAt = this.now();
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }
  private close(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.probeSuccesses = 0;
    this.probeInFlight = false;
  }
}

/** A breaker registry keyed by backend name (FS/DB/payment/email). One breaker per dependency. */
export class BreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();
  constructor(
    private readonly cfg: BreakerConfig = DEFAULT_BREAKER,
    private readonly now: () => number = Date.now,
  ) {}
  for(backend: string): CircuitBreaker {
    let b = this.breakers.get(backend);
    if (!b) {
      b = new CircuitBreaker(this.cfg, this.now);
      this.breakers.set(backend, b);
    }
    return b;
  }
  states(): Record<string, BreakerState> {
    return Object.fromEntries([...this.breakers].map(([k, v]) => [k, v.current()]));
  }
}

// ── synchronous bounded retry (sandbox path) ──────────────────────────────────

export interface SyncRetryResult<T> {
  value?: T;
  ok: boolean;
  attempts: number;
  /** The per-attempt backoff delays that a REAL async adapter would have slept (ms). */
  plannedDelaysMs: number[];
  lastError?: unknown;
}

export interface SyncRetryOptions {
  backoff?: BackoffConfig;
  rng?: () => number;
  /** Override the transient classifier. */
  retryable?: (err: unknown) => boolean;
  /** Optional shared budget — when exhausted, retries stop immediately. */
  budget?: RetryBudget;
}

/**
 * Run a synchronous thunk with bounded retry on TRANSIENT errors only. Single layer. The thunk may
 * either throw (→ inspected by `retryable`) or return a value (→ success). Backoff delays are
 * computed and returned for telemetry; the sandbox does not actually sleep.
 */
export function withRetrySync<T>(fn: () => T, opts: SyncRetryOptions = {}): SyncRetryResult<T> {
  const cfg = opts.backoff ?? DEFAULT_BACKOFF;
  const retryable = opts.retryable ?? isTransient;
  const plannedDelaysMs: number[] = [];
  let lastError: unknown;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const value = fn();
      opts.budget?.onSuccess();
      return { value, ok: true, attempts: attempt + 1, plannedDelaysMs };
    } catch (err) {
      lastError = err;
      const isLast = attempt === cfg.maxRetries;
      if (isLast || !retryable(err)) break;
      if (opts.budget && !opts.budget.tryAcquire()) break; // budget exhausted → fail fast
      plannedDelaysMs.push(backoffDelay(attempt, cfg, opts.rng));
    }
  }
  return { ok: false, attempts: plannedDelaysMs.length + 1, plannedDelaysMs, lastError };
}

// ── asynchronous helpers (the real-adapter path) ──────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Reject if `promise` doesn't settle within `ms`. Use on every outbound call to a real backend. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Async bounded retry on transient errors — for real backends. Actually sleeps the backoff. */
export async function withRetryAsync<T>(fn: () => Promise<T>, opts: SyncRetryOptions & { sleepFn?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const cfg = opts.backoff ?? DEFAULT_BACKOFF;
  const retryable = opts.retryable ?? isTransient;
  const doSleep = opts.sleepFn ?? sleep;
  let lastError: unknown;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const value = await fn();
      opts.budget?.onSuccess();
      return value;
    } catch (err) {
      lastError = err;
      if (attempt === cfg.maxRetries || !retryable(err)) break;
      if (opts.budget && !opts.budget.tryAcquire()) break;
      await doSleep(backoffDelay(attempt, cfg, opts.rng));
    }
  }
  throw lastError;
}
