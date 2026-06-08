/**
 * Toffoli — a sandboxed "world" the executor can really act on.
 *
 * This is a self-contained, in-memory model of the kinds of systems an agent touches — a file
 * store, a row store (with a recoverable trash), a money ledger, an outbox for external sends, and
 * a set of tables. It exists so Toffoli's restitution plan can be EXECUTED and the result VERIFIED
 * end-to-end, rather than only planned. Nothing here touches the real disk or network.
 *
 * Every mutating method does two things: it changes the world, and it RETURNS the `AgentAction`
 * that honestly describes what it did (with the real recovery signals). So the action log fed to
 * the classifier is generated from genuine operations, not hand-authored.
 *
 * Zero dependencies.
 */

import type { AgentAction } from "../engine/types";

export interface WorldState {
  files: Record<string, string>;
  rows: Record<string, unknown>; // key = `${table}:${id}`
  trashRows: Record<string, unknown>; // soft-deleted rows, recoverable
  tables: string[];
  ledgerUsd: number; // net money moved (a refund nets a charge to 0)
  outbox: string[]; // external sends — irreversible
}

/**
 * The inverse-operation surface the executor dispatches to. The in-memory `World` and the real-I/O
 * `FsWorld` (lib/exec/fs-world.ts) both implement it, so the executor is BACKEND-AGNOSTIC: the
 * sandbox is the permanent default, and a real adapter is a drop-in that touches actual disk. Every
 * inverse is idempotent per key and returns `true` on success / `false` on a no-op (nothing to undo).
 * This is the seam a production adapter slots into behind `mode: execute`.
 */
export interface RecoveryWorld {
  deleteFile(path: string, idemKey: string): boolean;
  restoreRow(key: string, idemKey: string): boolean;
  refund(amountUsd: number, idemKey: string): boolean;
  /** Read the current state into the shared shape, for end-to-end verification against a baseline. */
  snapshot(): WorldState;
}

export class World implements RecoveryWorld {
  private files = new Map<string, string>();
  private rows = new Map<string, unknown>();
  private trashRows = new Map<string, unknown>();
  private tables = new Set<string>();
  private ledgerUsd = 0;
  private outbox: string[] = [];
  private applied = new Set<string>(); // idempotency keys already applied (makes replay a no-op)
  private seq = 0;

  /** Apply an inverse exactly once per idempotency key; a replay is a success-skip, never a re-apply. */
  private once(idemKey: string, fn: () => boolean): boolean {
    if (this.applied.has(idemKey)) return true; // already applied → skip, report success
    const ok = fn();
    if (ok) this.applied.add(idemKey);
    return ok;
  }

  private nextId(): string {
    this.seq += 1;
    return `op${this.seq}`;
  }

  // ── seed (no action emitted) ──
  seedRow(table: string, id: string, value: unknown): void {
    this.rows.set(`${table}:${id}`, value);
  }
  seedTable(name: string): void {
    this.tables.add(name);
  }

  // ── mutating operations (each returns the AgentAction it represents) ──

  writeFile(path: string, content: string): AgentAction {
    this.files.set(path, content);
    return { id: this.nextId(), tool: "fs.write", op: "create", target: { kind: "file", id: path }, effect: `created ${path}`, at: this.stamp() };
  }

  /** Soft delete — keeps a recoverable copy in trash (→ REVERSIBLE). */
  softDeleteRow(table: string, id: string): AgentAction {
    const key = `${table}:${id}`;
    if (this.rows.has(key)) this.trashRows.set(key, this.rows.get(key));
    this.rows.delete(key);
    return { id: this.nextId(), tool: "db.execute", params: { sql: `DELETE FROM ${table} WHERE id = '${id}'` }, target: { kind: "db.row", id: key, recoverable: true }, effect: `soft-deleted ${key}`, at: this.stamp() };
  }

  /** A refundable charge (→ COMPENSABLE). */
  charge(merchant: string, amountUsd: number): AgentAction {
    this.ledgerUsd += amountUsd;
    return { id: this.nextId(), tool: "stripe.charge", op: "pay", params: { amountUsd }, target: { kind: "payment", id: merchant, externalized: false }, effect: `charged $${amountUsd} at ${merchant}`, at: this.stamp() };
  }

  /** A hard table drop with no backup (→ IRREVERSIBLE). */
  dropTable(name: string): AgentAction {
    this.tables.delete(name);
    return { id: this.nextId(), tool: "db.execute", params: { sql: `DROP TABLE ${name}` }, effect: `dropped table ${name}`, at: this.stamp() };
  }

  /** An external send (→ IRREVERSIBLE — there is no un-send). */
  sendEmail(to: string, body: string): AgentAction {
    this.outbox.push(`${to}: ${body}`);
    return { id: this.nextId(), tool: "email.send", op: "send", target: { kind: "email", externalized: true }, effect: `emailed ${to}`, at: this.stamp() };
  }

  // ── inverse operations the executor calls (idempotent per key; return true on success) ──
  deleteFile(path: string, idemKey: string): boolean {
    return this.once(idemKey, () => this.files.delete(path));
  }
  restoreRow(key: string, idemKey: string): boolean {
    return this.once(idemKey, () => {
      if (!this.trashRows.has(key)) return false;
      this.rows.set(key, this.trashRows.get(key));
      this.trashRows.delete(key);
      return true;
    });
  }
  refund(amountUsd: number, idemKey: string): boolean {
    return this.once(idemKey, () => {
      this.ledgerUsd -= amountUsd;
      return true;
    });
  }

  // ── inspection ──
  snapshot(): WorldState {
    return {
      files: Object.fromEntries(this.files),
      rows: Object.fromEntries(this.rows),
      trashRows: Object.fromEntries(this.trashRows),
      tables: [...this.tables].sort(),
      ledgerUsd: this.ledgerUsd,
      outbox: [...this.outbox],
    };
  }

  private stamp(): string {
    // deterministic monotonically-increasing timestamp (no Date.now — keeps runs reproducible)
    return `2026-06-05T09:${String(this.seq).padStart(2, "0")}:00Z`;
  }
}
