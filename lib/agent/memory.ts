/**
 * Toffoli — CROSS-RUN RECOVERY MEMORY for the self-healing agent loop.
 *
 * A self-healing agent that re-derives the same recovery from scratch every time it hits the same
 * fault is not really *learning* — it is just retrying. This module gives the loop a memory: when a
 * fault recurs with the same SHAPE, the agent recalls the strategy that worked last time and takes it
 * DIRECTLY, skipping the re-planning (the per-action reversibility classification cascade — the step
 * that can reach for the LLM judge). Memory is a named Agent-Engineer must-have; this is the seam.
 *
 * ── WHAT IS KEYED, AND WHY IT IS SHAPE-NOT-ID ──
 * A "fault signature" is a stable hash of the FAILED ACTION SHAPE — the trigger tool plus the ordered
 * structural features of the actions being recovered (`tool | op | target.kind | recoverable |
 * externalized | committed`). It deliberately ignores volatile fields (the per-run action id, the
 * timestamp, concrete values), so the SAME class of fault — an over-broad bulk delete of recoverable
 * rows, say — collides to the SAME signature across runs and across processes, even though every
 * concrete action id differs. That is exactly what makes the memory cross-RUN rather than
 * within-a-single-object.
 *
 * ── WHAT IS STORED, AND THE ASYMMETRIC-COST GUARD ──
 * Against a signature we store the recovery STRATEGY that worked: the ordered reversibility verdicts
 * (positional — ids are re-stamped onto the current run's actions on recall), plus the restored /
 * escalated counts and whether the recovery's anti-fabrication check PASSED. `recall` returns a
 * strategy ONLY when the stored recovery passed — a fault whose recovery fabricated or failed is
 * never offered back as "known-good." A later failing recovery of an already-known-good signature
 * bumps the recurrence counter but NEVER downgrades the stored strategy. This mirrors the engine-wide
 * invariant: bias toward NOT auto-replaying something you cannot stand behind.
 *
 * Persistence is the same discipline as SqlWorld: a `node:sqlite` store, `:memory:` by default so a
 * test or a single run touches no disk, and an optional file path for durable cross-process memory.
 * Every value is bound, never interpolated, so a signature/strategy is never an injection surface.
 *
 * Zero runtime dependencies (node:sqlite + node:crypto only).
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { AgentAction, Classification } from "../engine/types";

/** The structural fingerprint of one action — the fields that drive its reversibility class, no more. */
function actionShape(a: AgentAction): string {
  const op = a.op ?? "";
  const kind = a.target?.kind ?? "";
  const rec = a.target?.recoverable === undefined ? "-" : a.target.recoverable ? "1" : "0";
  const ext = a.target?.externalized === undefined ? "-" : a.target.externalized ? "1" : "0";
  const committed = a.committed === false ? "0" : "1"; // committed defaults true (see AgentAction)
  return `${a.tool}|${op}|${kind}|r${rec}|e${ext}|c${committed}`;
}

/**
 * A stable signature for a fault: the triggering tool plus the ordered shapes of the actions being
 * recovered. Two faults of the same shape — different ids, different timestamps, different concrete
 * values — produce the SAME signature, which is what lets memory match a repeat across runs.
 */
export function faultSignature(actions: AgentAction[], trigger: string): string {
  const canonical = JSON.stringify({ trigger, shapes: actions.map(actionShape) });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** What a completed recovery reports back to memory so a future identical fault can reuse it. */
export interface RecoveryMemoryOutcome {
  /**
   * The per-action reversibility verdicts that drove THIS recovery, in run order. Positional: the
   * ids are not load-bearing (they are re-stamped onto the current actions on recall).
   */
  classifications: Classification[];
  /** Recoverable actions auto-reverted to the pre-damage baseline. */
  restored: number;
  /** Irreversible remainder escalated to a human. */
  escalated: number;
  /** True iff the recovery's anti-fabrication check passed — ONLY a passing recovery is "known-good." */
  fabricationPass: boolean;
}

/** A prior successful recovery, returned by `recall`. Null is returned when there is no known-good one. */
export interface RecalledStrategy {
  /** The cached verdicts, in run order — re-stamp onto the current actions by position. */
  classifications: Classification[];
  restored: number;
  escalated: number;
  /** How many times this signature has been seen (>=1). >1 means the fault genuinely recurred. */
  timesSeen: number;
}

interface MemoryRow {
  signature: string;
  strategy: string;
  restored: number;
  escalated: number;
  fabrication_pass: number;
  times_seen: number;
  first_seen: string;
  last_seen: string;
}

export interface RecoveryMemoryOptions {
  /** Injected clock for deterministic first/last-seen stamps in tests. Default: wall clock. */
  clock?: () => string;
}

/**
 * A recovery-memory store keyed by fault signature, backed by `node:sqlite`.
 *
 * Default `:memory:` so tests and one-off runs need no disk file; pass a real path for durable,
 * cross-process (hence genuinely cross-run) memory.
 */
export class RecoveryMemory {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly clock: () => string;
  private readonly q: {
    get: ReturnType<DatabaseSync["prepare"]>;
    insert: ReturnType<DatabaseSync["prepare"]>;
    updateGood: ReturnType<DatabaseSync["prepare"]>;
    touch: ReturnType<DatabaseSync["prepare"]>;
  };

  constructor(path = ":memory:", opts: RecoveryMemoryOptions = {}) {
    this.path = path;
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recovery_memory (
        signature        TEXT PRIMARY KEY,
        strategy         TEXT    NOT NULL,
        restored         INTEGER NOT NULL,
        escalated        INTEGER NOT NULL,
        fabrication_pass INTEGER NOT NULL,
        times_seen       INTEGER NOT NULL,
        first_seen       TEXT    NOT NULL,
        last_seen        TEXT    NOT NULL
      );
    `);
    const p = (sql: string) => this.db.prepare(sql);
    this.q = {
      get: p(`SELECT * FROM recovery_memory WHERE signature = ?`),
      insert: p(`INSERT INTO recovery_memory (signature, strategy, restored, escalated, fabrication_pass, times_seen, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`),
      // Overwrite the stored strategy ONLY with a passing recovery (keeps a known-good strategy good).
      updateGood: p(`UPDATE recovery_memory SET strategy = ?, restored = ?, escalated = ?, fabrication_pass = 1, times_seen = ?, last_seen = ? WHERE signature = ?`),
      // Bump the recurrence counter without touching the (possibly known-good) stored strategy.
      touch: p(`UPDATE recovery_memory SET times_seen = ?, last_seen = ? WHERE signature = ?`),
    };
  }

  private getRow(signature: string): MemoryRow | undefined {
    return this.q.get.get(signature) as MemoryRow | undefined;
  }

  /**
   * Record the outcome of a recovery against its fault signature. ALWAYS call this after a recovery,
   * pass or fail — a failing outcome still bumps the recurrence counter (so the fault is *seen*),
   * but it never overwrites or downgrades an already-known-good strategy (asymmetric-cost guard).
   */
  record(signature: string, outcome: RecoveryMemoryOutcome): void {
    const now = this.clock();
    const strategy = JSON.stringify(outcome.classifications);
    const existing = this.getRow(signature);
    if (!existing) {
      this.q.insert.run(signature, strategy, outcome.restored, outcome.escalated, outcome.fabricationPass ? 1 : 0, now, now);
      return;
    }
    const timesSeen = existing.times_seen + 1;
    if (outcome.fabricationPass) {
      this.q.updateGood.run(strategy, outcome.restored, outcome.escalated, timesSeen, now, signature);
    } else {
      this.q.touch.run(timesSeen, now, signature); // never downgrade a good strategy
    }
  }

  /**
   * Recall the prior SUCCESSFUL recovery strategy for a fault signature, or null if none is known
   * good. A signature whose only recorded recoveries failed/fabricated returns null — the loop then
   * plans the recovery from scratch rather than replay something that did not work.
   */
  recall(signature: string): RecalledStrategy | null {
    const row = this.getRow(signature);
    if (row?.fabrication_pass !== 1) return null;
    return {
      classifications: JSON.parse(row.strategy) as Classification[],
      restored: row.restored,
      escalated: row.escalated,
      timesSeen: row.times_seen,
    };
  }

  /** Release the underlying database handle (matters for a file-backed DB; harmless for :memory:). */
  close(): void {
    this.db.close();
  }
}
