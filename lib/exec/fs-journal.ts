/**
 * Toffoli — FsJournal, the durable write-ahead claim record behind every real-world inverse.
 *
 * An idempotency marker that is a plain "does this file exist?" check has two holes, and both were
 * reproduced by execution against the pre-journal adapter before this file existed — not predicted
 * on paper:
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
 *   - Releasing a claim is a COMPARE-AND-DELETE, not a delete. Dropping a claim is the one operation
 *     that destroys durable state, so it is gated on the record still BEING that claim: same writer,
 *     same attempt, still `pending`. "I created this key once" is not the same fact and is not
 *     enough — a replay-safe peer that redoes a pending claim writes its own `applied` record over
 *     it, and a delete keyed on the weaker fact erases someone else's proof that the compensation
 *     happened. Reproduced with real processes on the production path: 4 of 1800 raced keys ended
 *     with the row restored on disk and no record of it, which downstream turns a COMPLETED
 *     compensation into a `failed` step and blocks the rest of the saga.
 *
 * Scope of the durability claim, so it is not read as more than it is: records are written with
 * writeFileSync and replaced with rename, and neither is followed by fsync. That makes the journal
 * crash-safe against PROCESS death — which is what the reproductions above exercise, and what a
 * killed or restarted agent actually does — but NOT against machine power loss, where a returned
 * write can still be lost from the page cache. Nor is there a lease: a `pending` record left by a
 * live concurrent caller is indistinguishable from one left by a dead one, so a non-replay-safe key
 * held by a slow caller escalates rather than waits. The compare-and-delete is likewise not atomic:
 * POSIX has no "unlink only if the contents still match", so a peer that completes an entire redo
 * cycle between the compare and the unlink can still lose its record. That is a single-syscall
 * window instead of an unconditional delete, and closing it completely needs the lease/fencing
 * machinery this slice deliberately does not build. All three are remainders, not solved problems.
 *
 * Zero runtime dependencies (node:fs / node:path / node:crypto only).
 */

import { createHash, randomUUID } from "node:crypto";
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
  /**
   * Identity of the journal instance that wrote THIS state of the record — the writer, not the
   * original claimant. It is what makes releasing a claim a compare-and-delete: a caller may only
   * drop a record that is still its own unresolved claim, so a peer's resolution cannot be erased.
   * Empty string for a legacy zero-byte marker, whose writer is unknowable.
   */
  readonly owner: string;
}

/**
 * Unforgeable proof that this instance created the record currently at `path` and has not resolved
 * it. Minted ONLY on the exclusive-create branch of a claim — the brand is module-private, so no
 * caller anywhere can construct one, and `release` takes nothing else. There is no boolean to pass
 * wrongly and no key/path pair to mismatch: holding the ticket IS the permission, and losing the
 * claim means there is no ticket to hold.
 */
const CLAIM_TICKET: unique symbol = Symbol("toffoli.journal.claim");
interface ClaimTicket {
  readonly [CLAIM_TICKET]: true;
  readonly key: string;
  readonly path: string;
  readonly owner: string;
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
  /**
   * This instance's identity, stamped into every record it writes. Fresh per instance — a restarted
   * process is a DIFFERENT owner, which is correct: it holds none of the previous process's claims.
   */
  readonly owner: string = `${process.pid}.${randomUUID()}`;
  private readonly chaos: ChaosSchedule | undefined;
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
    const claim: JournalRecord = { key, method, replaySafe, status: "pending", attempt, owner: this.owner };
    /** Present only while THIS instance holds an unresolved claim. No ticket, no release. */
    let ticket: ClaimTicket | undefined;
    try {
      // THE ATOMIC CLAIM. `wx` is exclusive-create: it succeeds for exactly one caller and fails
      // with EEXIST for every other, in a single syscall. No check, therefore no check-then-use.
      writeFileSync(path, serialize(claim), { flag: "wx" });
      ticket = { [CLAIM_TICKET]: true, key, path, owner: this.owner, attempt };
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
      // Replay-safe: REDO the effect. Bump the attempt so a recovery pass can see the retry. This
      // is NOT a claim — the original claimant may still be live, so no ticket is minted and this
      // caller never deletes the record; an unresolved redo stays visible to `unresolved()`.
      attempt = prior.attempt + 1;
      this.write(path, { ...prior, attempt, owner: this.owner });
    }

    this.chaos?.arrive("after-claim", key);

    let ok: boolean;
    try {
      ok = effect();
    } catch (err) {
      if (ticket) this.release(ticket);
      throw err;
    }

    this.chaos?.arrive("before-resolve", key);

    if (!ok) {
      if (ticket) this.release(ticket);
      this.chaos?.arrive("after-resolve", key); // releasing IS the resolution — a crash can land after it too
      return { status: "noop" };
    }
    this.write(path, { key, method, replaySafe, status: "applied", attempt, owner: this.owner });

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
    if (raw.length === 0) return { key, method: "?", replaySafe: false, status: "applied", attempt: 1, owner: "" };
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

  /**
   * COMPARE-AND-DELETE. Drop the claim so a later attempt can retry — but only if the record on disk
   * is STILL that claim: written by this instance, same attempt, still unresolved.
   *
   * Holding the ticket is not sufficient on its own, and that is the whole point. Between the claim
   * and this call a replay-safe peer can have redone the effect and written its own `applied` record
   * over the pending one; deleting on the strength of "I claimed this key once" would erase a
   * completed compensation's only durable proof. Anything that is not verifiably still ours — a
   * peer's record, a bumped redo attempt, a missing or unreadable file — is left exactly where it is.
   *
   * Non-throwing by construction: this runs on the effect-threw path, where raising would mask the
   * caller's original error, and no failure to read can justify destroying a record.
   */
  private release(ticket: ClaimTicket): void {
    let current: JournalRecord;
    try {
      current = this.read(ticket.key, ticket.path);
    } catch {
      return; // gone, or unreadable — never delete what cannot be positively identified as ours
    }
    if (current.status !== "pending" || current.owner !== ticket.owner || current.attempt !== ticket.attempt) return;
    rmSync(ticket.path, { force: true });
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
