/**
 * Toffoli — a REAL-filesystem-backed recovery world (the `mode: execute` reference adapter).
 *
 * The sandbox `World` proves the recovery loop on an in-memory model. `FsWorld` proves it on the
 * ACTUAL disk: genuine file writes/deletes, a persisted JSON row store with a real trash directory,
 * a persisted money ledger, and idempotency markers written to disk — so a replayed compensation is
 * a no-op even across a *process restart* (the marker survives). Same inverse surface
 * (`RecoveryWorld`), so the EXACT executor and safe-executor run against it unchanged; the only
 * difference is the I/O is real and fallible (ENOENT, EACCES, partial writes are now possible, not
 * simulated). This is the seam a production backend slots into.
 *
 * Why it stays low-maintenance and safe to leave unattended:
 *  - Everything lives under ONE root directory you pass in (use an os.tmpdir() path). All file paths
 *    are resolved under that root and a traversal outside it throws — it cannot touch anything else.
 *  - It is OFF by default: Toffoli's live default remains plan-only / sandbox / escalate. This
 *    adapter only runs when a caller explicitly opts into real execution. (Matches the 2026
 *    auto-remediation consensus: never autonomously write to real systems without a gate.)
 *
 * Zero runtime dependencies (node:fs / node:path / node:os / node:crypto only).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AgentAction } from "../engine/types";
import type { RecoveryWorld, WorldState } from "./world";

/**
 * Validate a single path segment (table / row id). THROWS on a separator or parent-dir escape rather
 * than silently rewriting it — a lossy rewrite could collide two distinct ids onto one file and clobber
 * data. A loud failure is the honest behavior; ids must not contain path separators or '..'.
 */
function seg(s: string): string {
  if (s.length === 0 || /[/\\]/.test(s) || s.includes("..")) {
    throw new Error(`unsafe path segment ${JSON.stringify(s)} — table/row ids must not contain path separators or '..'`);
  }
  return s;
}
/** Split a `${table}:${id}` row key on the FIRST colon (ids may contain colons). */
function splitKey(key: string): [string, string] | null {
  const i = key.indexOf(":");
  if (i < 0) return null;
  return [key.slice(0, i), key.slice(i + 1)];
}

export class FsWorld implements RecoveryWorld {
  readonly root: string;
  private readonly filesDir: string;
  private readonly rowsDir: string;
  private readonly trashDir: string;
  private readonly tablesDir: string;
  private readonly outboxDir: string;
  private readonly appliedDir: string;
  private readonly ledgerPath: string;
  private seq = 0;

  constructor(root: string) {
    this.root = resolve(root);
    this.filesDir = join(this.root, "files");
    this.rowsDir = join(this.root, "rows");
    this.trashDir = join(this.root, "trash", "rows");
    this.tablesDir = join(this.root, "tables");
    this.outboxDir = join(this.root, "outbox");
    this.appliedDir = join(this.root, "applied");
    this.ledgerPath = join(this.root, "ledger.json");
    for (const d of [this.filesDir, this.rowsDir, this.trashDir, this.tablesDir, this.outboxDir, this.appliedDir]) {
      mkdirSync(d, { recursive: true });
    }
    if (!existsSync(this.ledgerPath)) this.writeLedger(0);
  }

  // ── idempotency persisted to disk (survives a process restart) ──
  private once(idemKey: string, fn: () => boolean): boolean {
    const marker = join(this.appliedDir, createHash("sha256").update(idemKey).digest("hex").slice(0, 32));
    if (existsSync(marker)) return true; // already applied → skip, report success (never re-apply)
    // MARKER-FIRST: claim the key BEFORE the side effect. This is what makes the one non-self-idempotent
    // inverse (refund) safe across a crash: if the marker write itself fails (EACCES/ENOSPC), the side
    // effect never runs; if the process dies in the tiny window after the marker but before the side
    // effect, a replay safely SKIPS — a rare lost-compensation, which is the asymmetric-cost-correct
    // failure for money (never refund twice). If the side effect FAILS or no-ops, we release the claim
    // so a legitimate retry can re-run it.
    writeFileSync(marker, "");
    let ok = false;
    try {
      ok = fn();
    } catch (err) {
      rmSync(marker, { force: true }); // failed attempt → release the claim so a retry can re-run
      throw err;
    }
    if (!ok) rmSync(marker, { force: true }); // no-op / not found → release the claim
    return ok;
  }

  // ── safe path mapping ──
  private filePath(logical: string): string {
    const rel = logical.replace(/^[/\\]+/, "");
    const abs = resolve(this.filesDir, rel);
    if (abs !== this.filesDir && !abs.startsWith(this.filesDir + sep)) {
      throw new Error(`path escapes sandbox root: ${logical}`);
    }
    return abs;
  }
  private rowPath(table: string, id: string, trash = false): string {
    return join(trash ? this.trashDir : this.rowsDir, seg(table), `${seg(id)}.json`);
  }

  private nextId(): string {
    this.seq += 1;
    return `op${this.seq}`;
  }
  private stamp(): string {
    // deterministic monotonic timestamp (no Date.now — keeps runs reproducible, like World)
    return `2026-06-06T09:${String(this.seq).padStart(2, "0")}:00Z`;
  }
  private readLedger(): number {
    if (!existsSync(this.ledgerPath)) return 0; // legitimately absent → $0
    // A present-but-unparseable ledger is a real corruption — surface it, never mask it as a valid $0.
    return (JSON.parse(readFileSync(this.ledgerPath, "utf8")) as { usd?: number }).usd ?? 0;
  }
  private writeLedger(usd: number): void {
    const tmp = `${this.ledgerPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ usd }));
    renameSync(tmp, this.ledgerPath); // atomic replace — no torn ledger if a crash interrupts the write
  }

  // ── seed (no action emitted) ──
  seedRow(table: string, id: string, value: unknown): void {
    const p = this.rowPath(table, id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(value));
  }
  seedTable(name: string): void {
    mkdirSync(join(this.tablesDir, seg(name)), { recursive: true });
  }

  // ── damage operations (REAL I/O; each returns the AgentAction it represents) ──
  writeFile(path: string, content: string): AgentAction {
    const p = this.filePath(path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    return { id: this.nextId(), tool: "fs.write", op: "create", target: { kind: "file", id: path }, effect: `created ${path}`, at: this.stamp() };
  }
  softDeleteRow(table: string, id: string): AgentAction {
    const src = this.rowPath(table, id);
    const dst = this.rowPath(table, id, true);
    const key = `${table}:${id}`;
    if (existsSync(src)) {
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(src, dst);
    }
    return { id: this.nextId(), tool: "db.execute", params: { sql: `DELETE FROM ${table} WHERE id = '${id}'` }, target: { kind: "db.row", id: key, recoverable: true }, effect: `soft-deleted ${key}`, at: this.stamp() };
  }
  charge(merchant: string, amountUsd: number): AgentAction {
    this.writeLedger(this.readLedger() + amountUsd);
    return { id: this.nextId(), tool: "stripe.charge", op: "pay", params: { amountUsd }, target: { kind: "payment", id: merchant, externalized: false }, effect: `charged $${amountUsd} at ${merchant}`, at: this.stamp() };
  }
  dropTable(name: string): AgentAction {
    rmSync(join(this.tablesDir, seg(name)), { recursive: true, force: true });
    return { id: this.nextId(), tool: "db.execute", params: { sql: `DROP TABLE ${name}` }, effect: `dropped table ${name}`, at: this.stamp() };
  }
  sendEmail(to: string, body: string): AgentAction {
    const id = this.nextId(); // one id for both the file and the AgentAction — keeps the seq aligned with World
    writeFileSync(join(this.outboxDir, `${id}.txt`), `${to}: ${body}`);
    return { id, tool: "email.send", op: "send", target: { kind: "email", externalized: true }, effect: `emailed ${to}`, at: this.stamp() };
  }

  // ── inverse operations the executor calls (idempotent per key) ──
  deleteFile(path: string, idemKey: string): boolean {
    return this.once(idemKey, () => {
      const p = this.filePath(path);
      if (!existsSync(p)) return false;
      rmSync(p);
      return true;
    });
  }
  restoreRow(key: string, idemKey: string): boolean {
    return this.once(idemKey, () => {
      const parts = splitKey(key);
      if (!parts) return false;
      const [table, id] = parts;
      const src = this.rowPath(table, id, true);
      const dst = this.rowPath(table, id, false);
      if (!existsSync(src)) return false;
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(src, dst);
      return true;
    });
  }
  refund(amountUsd: number, idemKey: string): boolean {
    return this.once(idemKey, () => {
      this.writeLedger(this.readLedger() - amountUsd);
      return true;
    });
  }

  // ── inspection: read REAL disk into the shared WorldState shape ──
  snapshot(): WorldState {
    return {
      files: this.readFiles(),
      rows: this.readRows(false),
      trashRows: this.readRows(true),
      tables: this.readTables(),
      ledgerUsd: this.readLedger(),
      outbox: this.readOutbox(),
    };
  }

  /** Recursively list every regular file under a dir as absolute paths. */
  private walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...this.walk(p));
      else out.push(p);
    }
    return out;
  }
  private readFiles(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.walk(this.filesDir)) {
      const logical = `/${relative(this.filesDir, p).split(sep).join("/")}`;
      out[logical] = readFileSync(p, "utf8");
    }
    return out;
  }
  private readRows(trash: boolean): Record<string, unknown> {
    const base = trash ? this.trashDir : this.rowsDir;
    const out: Record<string, unknown> = {};
    for (const p of this.walk(base)) {
      const rel = relative(base, p).split(sep);
      const id = rel.pop()!.replace(/\.json$/, "");
      const table = rel.join("/");
      out[`${table}:${id}`] = JSON.parse(readFileSync(p, "utf8"));
    }
    return out;
  }
  private readTables(): string[] {
    if (!existsSync(this.tablesDir)) return [];
    return readdirSync(this.tablesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }
  private readOutbox(): string[] {
    return this.walk(this.outboxDir)
      .sort()
      .map((p) => readFileSync(p, "utf8"));
  }
}
