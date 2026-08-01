/**
 * Toffoli — FsJournal, the durable write-ahead claim record behind every real-world inverse.
 *
 * An idempotency marker that is a plain "does this file exist?" check has two holes, and both were
 * reproduced against this repo before this file existed (docs/plans/plans/2026-08-01-fs-journal-chaos.md):
 *
 *   1. SILENT LOST COMPENSATION. Claim-then-effect means a crash in between leaves a claim with no
 *      effect. The next run sees the claim and reports SUCCESS for work that never happened — a
 *      fabricated restoration, the exact failure the rest of this repo exists to prevent. Verified
 *      with a real SIGKILL parked in that window: `refund()` returned `true` with the money still
 *      taken.
 *   2. TOCTOU. `existsSync(marker)` followed by `writeFileSync(marker)` is a check-then-use, so two
 *      processes can both pass the check and both apply. Verified empirically: 12 of 15 trials with
 *      12 racers broke exactly-once, up to FOUR duplicate refunds.
 *
 * The fixes are structural, not defensive:
 *
 *   - The claim is ONE exclusive-create syscall (`flag: "wx"`). There is no window between check and
 *     use because there is no check; `EEXIST` is the loser's signal and the loser reads the winner's
 *     record. This is the same primitive a lockfile uses, and it is atomic on POSIX and Windows.
 *   - A claim carries the caller's `replaySafe` declaration. On recovery, an unresolved claim for a
 *     self-idempotent inverse (delete/restore) is REDONE; for one that is not (refund) it is raised
 *     as `indeterminate` — loud, typed, and routed to the saga's failure path. Never silently
 *     "restored", and never a second charge on someone's card.
 *   - A claim may only be released by the caller that created it, so one caller's failure cannot
 *     erase another's idempotency record (observed in the race probe: a successful refund whose
 *     marker count ended at zero).
 *
 * Scope of the durability claim, so it is not read as more than it is: records are written with
 * writeFileSync and replaced with rename, and neither is followed by fsync. That makes the journal
 * crash-safe against PROCESS death — which is what the reproductions above exercise, and what a
 * killed or restarted agent actually does — but NOT against machine power loss, where a returned
 * write can still be lost from the page cache. Nor is there a lease: a `pending` record left by a
 * live concurrent caller is indistinguishable from one left by a dead one, so a non-replay-safe key
 * held by a slow caller escalates rather than waits. Both are remainders, not solved problems.
 *
 * Zero runtime dependencies (node:fs / node:path / node:crypto only).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Every failure this seam can raise, as one closed set. */
export type JournalErrorCode =
  /** The intent failed boundary validation. Nothing was claimed and no effect ran. */
  | "invalid-intent"
  /** A previous attempt claimed this key and never resolved it, and the effect is not replay-safe. */
  | "indeterminate"
  /** A record exists on disk but cannot be read as a record. */
  | "corrupt-record"
  /** The underlying filesystem refused an operation. */
  | "io";

/** The single error shape for the whole journal surface. */
export class JournalError extends Error {
  readonly code: JournalErrorCode;
  readonly key: string | undefined;
  readonly record: JournalRecord | undefined;

  constructor(code: JournalErrorCode, message: string, opts: { key?: string; record?: JournalRecord; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "JournalError";
    this.code = code;
    this.key = opts.key;
    this.record = opts.record;
  }
}

/** `pending` = claimed, outcome unknown. `applied` = the effect is durably known to have happened. */
export type RecordStatus = "pending" | "applied";

export interface JournalRecord {
  readonly key: string;
  /** Which inverse this claim belongs to — carried so a recovery pass can report what is stuck. */
  readonly method: string;
  /** Declared by the caller: may this effect be re-run after an unresolved crash? */
  readonly replaySafe: boolean;
  readonly status: RecordStatus;
  /** 1 on the first claim; incremented each time an unresolved claim is redone. */
  readonly attempt: number;
}

/** What the caller is about to do, once. */
export interface OnceIntent {
  /** Stable identity of this compensation step. Hashed for the on-disk name, so any string is safe. */
  key: string;
  method: string;
  /**
   * TRUE only if running the effect twice is indistinguishable from running it once (delete a file,
   * restore a row). FALSE for anything that moves money or sends a message. This is the single
   * declaration that decides whether recovery may redo a crashed step or must escalate it.
   */
  replaySafe: boolean;
}

export type OnceOutcome =
  /** The effect ran and its success is durably recorded. */
  | { status: "applied"; attempt: number }
  /** The effect reported nothing to do; the claim was released so a later real attempt can run. */
  | { status: "noop" }
  /** A previous run already applied this key; the effect was NOT re-run. */
  | { status: "already-applied"; attempt: number };

/**
 * The complete kill-point space of one `runOnce` cycle. Exhaustive by construction — a crash can
 * only land before the claim, between the claim and the effect, between the effect and its
 * resolution, or after everything is durable. The chaos tests enumerate all four rather than
 * sampling, which is why they are deterministic instead of lucky.
 */
export const JOURNAL_POINTS = ["before-claim", "after-claim", "before-resolve", "after-resolve"] as const;
export type JournalPoint = (typeof JOURNAL_POINTS)[number];

/**
 * Deterministic fault / interleaving injection. Production passes nothing and the journal makes no
 * call at all; this exists so a crash or a concurrent claim can be placed at an EXACT point instead
 * of being raced for.
 */
export interface ChaosSchedule {
  arrive(point: JournalPoint, key: string): void;
}

export interface FsJournalOptions {
  chaos?: ChaosSchedule;
}

/** Maximum key length. Longer keys are refused rather than truncated onto a colliding record. */
const MAX_KEY_LENGTH = 1024;

export class FsJournal {
  readonly dir: string;
  private readonly chaos: ChaosSchedule | undefined;
  /** Keys THIS instance created a claim for — the only claims it is allowed to release. */
  private readonly created = new Set<string>();
  private tmpSeq = 0;

  constructor(dir: string, opts: FsJournalOptions = {}) {
    this.dir = dir;
    this.chaos = opts.chaos;
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Claim `intent.key`, run `effect` at most once for it, and durably record the outcome.
   *
   * @throws {JournalError} `invalid-intent` on a malformed intent (before anything is claimed),
   *   `indeterminate` when a previous attempt crashed mid-flight and the effect is not replay-safe,
   *   `corrupt-record` when an existing record cannot be read, `io` when the claim write fails.
   *   An error thrown by `effect` itself is released and re-thrown unchanged.
   */
  runOnce(intent: OnceIntent, effect: () => boolean): OnceOutcome {
    const { key, method, replaySafe } = validate(intent);
    const path = this.pathFor(key);

    this.chaos?.arrive("before-claim", key);

    let attempt = 1;
    const claim: JournalRecord = { key, method, replaySafe, status: "pending", attempt };
    let owned = false;
    try {
      // THE ATOMIC CLAIM. `wx` is exclusive-create: it succeeds for exactly one caller and fails
      // with EEXIST for every other, in a single syscall. No check, therefore no check-then-use.
      writeFileSync(path, serialize(claim), { flag: "wx" });
      owned = true;
      this.created.add(key);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new JournalError("io", `could not claim ${JSON.stringify(key)}: ${(err as Error).message}`, { key, cause: err });
      }
      // We lost the claim. The winner's record decides what happens next.
      const prior = this.read(key, path);
      if (prior.status === "applied") return { status: "already-applied", attempt: prior.attempt };
      if (!replaySafe) {
        // A claim with no recorded outcome. The effect may or may not have happened, and re-running
        // it is not safe. Refusing loudly is the only honest answer: the saga records a failed step
        // and a resume point, and a human resolves it. Reporting success here is the bug this
        // whole file exists to remove.
        throw new JournalError(
          "indeterminate",
          `${JSON.stringify(key)} was claimed by an earlier attempt that never resolved, and ${JSON.stringify(method)} is not replay-safe — refusing to report success or to re-apply`,
          { key, record: prior },
        );
      }
      // Replay-safe: REDO the effect. Bump the attempt so a recovery pass can see the retry.
      attempt = prior.attempt + 1;
      this.write(path, { ...prior, attempt });
    }

    this.chaos?.arrive("after-claim", key);

    let ok: boolean;
    try {
      ok = effect();
    } catch (err) {
      this.release(key, path, owned);
      throw err;
    }

    this.chaos?.arrive("before-resolve", key);

    if (!ok) {
      this.release(key, path, owned);
      this.chaos?.arrive("after-resolve", key); // releasing IS the resolution — a crash can land after it too
      return { status: "noop" };
    }
    this.write(path, { key, method, replaySafe, status: "applied", attempt });

    this.chaos?.arrive("after-resolve", key);
    return { status: "applied", attempt };
  }

  /** The durable record for a key, or undefined if there is none. */
  lookup(key: string): JournalRecord | undefined {
    const path = this.pathFor(validateKey(key));
    if (!existsSync(path)) return undefined;
    return this.read(key, path);
  }

  /**
   * Claims that were made and never resolved — what a crash-recovery pass must deal with. Replay-safe
   * entries can be redone; the rest need a human.
   */
  unresolved(): JournalRecord[] {
    const out: JournalRecord[] = [];
    for (const name of readdirSync(this.dir).sort()) {
      if (name.endsWith(".tmp")) continue; // a torn resolve write, not a record
      const raw = readFileSync(join(this.dir, name), "utf8");
      if (raw.length === 0) continue; // legacy applied marker
      let rec: JournalRecord;
      try {
        rec = JSON.parse(raw) as JournalRecord;
      } catch (err) {
        throw new JournalError("corrupt-record", `journal record ${name} is not readable: ${(err as Error).message}`, { cause: err });
      }
      if (rec.status === "pending") out.push(rec);
    }
    return out;
  }

  // ── internals ──

  private pathFor(key: string): string {
    return join(this.dir, createHash("sha256").update(key).digest("hex").slice(0, 32));
  }

  private read(key: string, path: string): JournalRecord {
    const raw = readFileSync(path, "utf8");
    // A zero-byte file is what the pre-journal marker scheme wrote. Treat it as an applied record so
    // upgrading the code cannot cause an old root to be compensated a second time.
    if (raw.length === 0) return { key, method: "?", replaySafe: false, status: "applied", attempt: 1 };
    try {
      return JSON.parse(raw) as JournalRecord;
    } catch (err) {
      throw new JournalError("corrupt-record", `journal record for ${JSON.stringify(key)} is not readable: ${(err as Error).message}`, { key, cause: err });
    }
  }

  /** Atomic replace: write a uniquely-named temp then rename. The name must be unique PER WRITER — a
   *  shared temp path lets concurrent writers clobber each other and turns rename into ENOENT. */
  private write(path: string, rec: JournalRecord): void {
    this.tmpSeq += 1;
    const tmp = `${path}.${process.pid}.${this.tmpSeq}.tmp`;
    writeFileSync(tmp, serialize(rec));
    renameSync(tmp, path);
  }

  /** Drop a claim so a later attempt can retry — but ONLY one this instance created. */
  private release(key: string, path: string, owned: boolean): void {
    if (!owned || !this.created.has(key)) return; // never erase another caller's idempotency record
    rmSync(path, { force: true });
    this.created.delete(key);
  }
}

function serialize(rec: JournalRecord): string {
  return JSON.stringify(rec);
}

function validateKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new JournalError("invalid-intent", "idempotency key must be a non-empty string");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new JournalError("invalid-intent", `idempotency key exceeds ${MAX_KEY_LENGTH} characters`, { key });
  }
  if (key.includes("\0")) {
    throw new JournalError("invalid-intent", "idempotency key must not contain a NUL byte", { key });
  }
  return key;
}

/** Boundary validation. Runs before anything is claimed and before any effect is invoked. */
function validate(intent: OnceIntent): OnceIntent {
  if (intent === null || typeof intent !== "object") {
    throw new JournalError("invalid-intent", "intent must be an object");
  }
  const key = validateKey(intent.key);
  if (typeof intent.method !== "string" || intent.method.length === 0) {
    throw new JournalError("invalid-intent", "method must be a non-empty string", { key });
  }
  if (typeof intent.replaySafe !== "boolean") {
    throw new JournalError("invalid-intent", "replaySafe must be declared as a boolean — it decides whether recovery may redo a crashed step", { key });
  }
  return { key, method: intent.method, replaySafe: intent.replaySafe };
}
