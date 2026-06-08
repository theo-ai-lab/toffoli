/**
 * Toffoli — the write-ahead step journal (a transactional-outbox / WAL for restitution).
 *
 * Toffoli's value IS the attested rollback log. If a real-world side effect and its audit record
 * are two separate writes, a crash between them silently breaks the soundness story (AWS
 * Prescriptive Guidance, "transactional outbox"). So the discipline is classic write-ahead logging:
 *
 *   1. Record the INTENT ("about to run step <idemKey>") BEFORE the side effect.
 *   2. Run the (idempotent) inverse.
 *   3. Mark DONE (or FAILED) AFTER, recording the outcome.
 *
 * On crash-recovery, `pending()` returns the steps that were intended but never resolved; because
 * every inverse is keyed and idempotent (World.once / the idempotency key), replaying them is safe —
 * a Compensation Log Record is REDONE, never undone. This is also the anti-fabrication anchor: a
 * step may only be REPORTED "restored" if `confirms(idemKey)` is true — i.e. the durable journal
 * actually recorded the success. That is the invariant that defeats the Replit failure mode (an
 * agent that *reported* success it never achieved).
 *
 * The in-memory journal is serializable (→ D1/SQLite/R2 on deploy); the interface is what the
 * executor depends on, so the storage is swappable without touching the saga loop. Zero dependencies.
 */

export type JournalEntryStatus = "intended" | "done" | "failed";

export interface JournalEntry {
  /** The idempotency key — the stable identity of this compensation step. Primary key. */
  idemKey: string;
  forActionId: string;
  method: string;
  status: JournalEntryStatus;
  attempts: number;
  detail?: string;
  /** ISO timestamp the entry was last written. */
  at: string;
}

export interface IntentRecord {
  idemKey: string;
  forActionId: string;
  method: string;
}

/** The append-only journal the saga executor writes through. Storage-agnostic. */
export interface StepJournal {
  /** Write-ahead: record the intent BEFORE the side effect. Idempotent on idemKey. */
  intend(rec: IntentRecord): void;
  /** Mark a step durably succeeded AFTER the side effect. */
  complete(idemKey: string, detail: string, attempts: number): void;
  /** Mark a step durably failed AFTER the attempt(s). */
  fail(idemKey: string, detail: string, attempts: number): void;
  get(idemKey: string): JournalEntry | undefined;
  /** Steps intended but not yet resolved — what a crash-recovery pass must replay (idempotently). */
  pending(): JournalEntry[];
  entries(): JournalEntry[];
  /**
   * THE ANTI-FABRICATION CHECK. True iff the durable journal recorded this step as DONE. A reported
   * "restored" that is not `confirms()`-backed is a fabricated success — the exact Replit failure.
   */
  confirms(idemKey: string): boolean;
}

/** A monotonic ISO clock that does not call Date.now in tests (injectable). */
export type Clock = () => string;

export class InMemoryJournal implements StepJournal {
  private map = new Map<string, JournalEntry>();
  private order: string[] = [];
  /** Keys that went through a proper write-ahead intend(). confirms() requires this lineage. */
  private intended = new Set<string>();

  constructor(private readonly clock: Clock = () => new Date().toISOString()) {}

  intend(rec: IntentRecord): void {
    this.intended.add(rec.idemKey);
    const existing = this.map.get(rec.idemKey);
    if (existing) {
      // Re-intending an already-resolved step is a crash-replay; keep its resolved status.
      if (existing.status === "intended") existing.at = this.clock();
      return;
    }
    this.map.set(rec.idemKey, { ...rec, status: "intended", attempts: 0, at: this.clock() });
    this.order.push(rec.idemKey);
  }

  complete(idemKey: string, detail: string, attempts: number): void {
    this.write(idemKey, "done", detail, attempts);
  }
  fail(idemKey: string, detail: string, attempts: number): void {
    this.write(idemKey, "failed", detail, attempts);
  }

  private write(idemKey: string, status: JournalEntryStatus, detail: string, attempts: number): void {
    const e = this.map.get(idemKey);
    if (!e) {
      // resolve without a prior intent — record defensively, but this is a WAL violation upstream
      this.map.set(idemKey, { idemKey, forActionId: "?", method: "?", status, attempts, detail, at: this.clock() });
      this.order.push(idemKey);
      return;
    }
    e.status = status;
    e.detail = detail;
    e.attempts = attempts;
    e.at = this.clock();
  }

  get(idemKey: string): JournalEntry | undefined {
    return this.map.get(idemKey);
  }
  pending(): JournalEntry[] {
    return this.entries().filter((e) => e.status === "intended");
  }
  entries(): JournalEntry[] {
    return this.order.map((k) => this.map.get(k)!).filter(Boolean);
  }
  confirms(idemKey: string): boolean {
    // Anti-fabrication: a step counts as durably restored ONLY if it both went through a write-ahead
    // intend() AND was recorded "done" — a complete() with no preceding intent (a WAL-ordering
    // violation) does NOT confirm, so a fabricated "restored" can never pass this check.
    return this.intended.has(idemKey) && this.map.get(idemKey)?.status === "done";
  }

  /** Serialize for durable storage (D1 row set / R2 blob). */
  serialize(): JournalEntry[] {
    return this.entries().map((e) => ({ ...e }));
  }
  /** Rehydrate from durable storage on cold start, preserving order and the intend() lineage. */
  static load(rows: JournalEntry[], clock?: Clock): InMemoryJournal {
    const j = new InMemoryJournal(clock);
    for (const r of rows) {
      j.map.set(r.idemKey, { ...r });
      j.order.push(r.idemKey);
      j.intended.add(r.idemKey); // a durably-stored row was, by construction, intended before it was written
    }
    return j;
  }
}
