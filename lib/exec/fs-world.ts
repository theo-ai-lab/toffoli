/**
 * Toffoli — a REAL-filesystem-backed recovery world (the `mode: execute` reference adapter).
 *
 * The sandbox `World` proves the recovery loop on an in-memory model. `FsWorld` proves it on the
 * ACTUAL disk: genuine file writes/deletes, a persisted JSON row store with a real trash directory,
 * a persisted money ledger, and a durable write-ahead claim journal (`lib/exec/fs-journal.ts`) — so
 * a replayed compensation is a no-op even across a *process restart*, and a compensation interrupted
 * BY that restart is reported as unresolved rather than as done. Same inverse surface
 * (`RecoveryWorld`), so the EXACT executor and safe-executor run against it unchanged; the only
 * difference is the I/O is real and fallible (ENOENT, EACCES, partial writes are now possible, not
 * simulated). This is the seam a production backend slots into.
 *
 * What the journal changed, and what it did not: exactly-once now holds against CONCURRENT callers
 * on one root (the claim is a single exclusive-create syscall), and a crash between the claim and
 * the effect can no longer be reported as a success. The ledger's own read-modify-write is still
 * not serialisable — two callers compensating DIFFERENT keys at the same time can still lose a
 * ledger update. That is a known remaining gap, not a solved one.
 *
 * Because those records are durable, the NAMES they are filed under have to be too. Every
 * idempotency key is derived from the action id (`restitution:${action.id}:${method}`), so the
 * action-id counter is allocated from the root as well (see `nextId`) — a counter that restarted
 * with the process would let a brand-new compensation inherit the record of an unrelated old one and
 * be skipped while reporting success.
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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AgentAction } from "../engine/types";
import { FsJournal, type ChaosSchedule, type JournalRecord } from "./fs-journal";
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
/**
 * The highest `op<n>` this root has already handed out, or 0 for a root that has issued none. A
 * starting HINT for `nextId`'s probe, never the authority on what is free — see `nextId`.
 */
function highestAllocatedId(dir: string): number {
  let max = 0;
  for (const name of readdirSync(dir)) {
    const m = /^op(\d+)$/.exec(name);
    if (m === null) continue;
    const n = Number(m[1]);
    // A number too large to increment exactly would make the probe loop stop advancing. Junk that
    // big is not something this code ever wrote, so skip it rather than hang on it.
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

/** Split a `${table}:${id}` row key on the FIRST colon (ids may contain colons). */
function splitKey(key: string): [string, string] | null {
  const i = key.indexOf(":");
  if (i < 0) return null;
  return [key.slice(0, i), key.slice(i + 1)];
}

export interface FsWorldOptions {
  /**
   * Deterministic fault injection for the durability tests. Production passes nothing. See
   * lib/exec/chaos.ts — this is what lets a crash or a competing claim be placed at an exact point
   * instead of being raced for.
   */
  chaos?: ChaosSchedule;
}

export class FsWorld implements RecoveryWorld {
  readonly root: string;
  private readonly filesDir: string;
  private readonly rowsDir: string;
  private readonly trashDir: string;
  private readonly tablesDir: string;
  private readonly outboxDir: string;
  private readonly idsDir: string;
  private readonly ledgerPath: string;
  private readonly journal: FsJournal;
  /** The last action number THIS handle allocated. Also the next candidate to probe — see `nextId`. */
  private seq = 0;
  /** Whether `seq` has been raised to the root's durable high-water mark yet (a hint; see `nextId`). */
  private seqFloorRead = false;
  private tmpSeq = 0;

  constructor(root: string, opts: FsWorldOptions = {}) {
    this.root = resolve(root);
    this.filesDir = join(this.root, "files");
    this.rowsDir = join(this.root, "rows");
    this.trashDir = join(this.root, "trash", "rows");
    this.tablesDir = join(this.root, "tables");
    this.outboxDir = join(this.root, "outbox");
    this.idsDir = join(this.root, "ids");
    this.ledgerPath = join(this.root, "ledger.json");
    for (const d of [this.filesDir, this.rowsDir, this.trashDir, this.tablesDir, this.outboxDir, this.idsDir]) {
      mkdirSync(d, { recursive: true });
    }
    // The journal owns `applied/` — same directory the marker scheme used, now holding durable
    // records instead of empty files. A legacy zero-byte marker still reads as applied.
    this.journal = new FsJournal(join(this.root, "applied"), opts.chaos === undefined ? {} : { chaos: opts.chaos });
    if (!existsSync(this.ledgerPath)) this.writeLedger(0);
  }

  /**
   * Apply an inverse at most once per idempotency key, through the durable write-ahead journal.
   *
   * `replaySafe` is the load-bearing argument: it declares whether recovery may REDO this effect
   * after a crash left the claim unresolved. Self-idempotent inverses (delete, restore) say yes and
   * are recovered silently; `refund` says no, so an unresolved claim is raised as a typed
   * `JournalError` and becomes a failed saga step. What it can no longer do is what the old
   * marker scheme did — report `true` for a compensation that never happened.
   */
  private once(idemKey: string, method: string, replaySafe: boolean, fn: () => boolean): boolean {
    return this.journal.runOnce({ key: idemKey, method, replaySafe }, fn).status !== "noop";
  }

  /**
   * Compensations that were claimed and never resolved — what a crash-recovery pass must deal with.
   * A `replaySafe` entry can simply be re-run; the rest need a human.
   */
  unresolvedCompensations(): JournalRecord[] {
    return this.journal.unresolved();
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

  /**
   * Allocate the next action number FROM THE ROOT, not from this process.
   *
   * THE CONTRACT: an action id handed out for a root is never handed out again for that root, for as
   * long as the root's `ids/` and `applied/` directories live together. That is what the durable
   * journal needs, because every idempotency key is derived from the action id and the records are
   * durable: an id that repeats after a reopen makes a compensation that has NEVER run look like a
   * replay of one that has, so `once()` skips the effect and returns `true` — a restoration reported
   * for a row still in the trash, a refund reported for money still taken. (`replaySafe:false` is no
   * defence: an `applied` record is answered before the indeterminate check is reached.)
   *
   * HOW: the id IS its own durable record. `op<n>` is allocated by exclusive-creating the file
   * `ids/op<n>`; on EEXIST the number is already spoken for and we walk forward. This is the same
   * primitive as the journal's claim — one syscall, no check-then-use — so two live handles on one
   * root cannot take the same number either.
   *
   * CRASH SEMANTICS, deliberately: the file is empty and its NAME carries the whole fact, so there
   * is no torn write to recover from — `wx` either creates the directory entry or it does not. A
   * crash between allocating an id and using it LEAKS that id (the sequence skips a number) and can
   * never reuse it, which is the safe direction: a leaked number costs nothing, a reused one
   * fabricates a compensation. Same scope caveat as the journal (lib/exec/fs-journal.ts): no fsync,
   * so this is crash-safe against process death, not against machine power loss.
   *
   * SCOPE: this guarantees uniqueness for the life of a root created by this version. A root written
   * by an earlier one has no `ids/` directory and therefore no record of the ids it already issued,
   * so its counter restarts from zero — such a root must be recreated, not upgraded in place.
   */
  private nextId(): string {
    // First allocation on this handle: start from the root's high-water mark instead of re-probing
    // every number it has ever issued. A HINT only — the exclusive create below is the authority, so
    // a stale or racing hint costs extra probes, never uniqueness.
    if (!this.seqFloorRead) {
      this.seq = Math.max(this.seq, highestAllocatedId(this.idsDir));
      this.seqFloorRead = true;
    }
    for (;;) {
      const n = this.seq + 1;
      const id = `op${n}`;
      try {
        writeFileSync(join(this.idsDir, id), "", { flag: "wx" }); // THE ATOMIC ALLOCATION
        this.seq = n;
        return id;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new Error(`could not allocate an action id under ${this.idsDir}: ${(err as Error).message}`, { cause: err });
        }
        this.seq = n; // taken by an earlier process or a live peer — walk forward
      }
    }
  }
  private stamp(): string {
    // Deterministic monotonic timestamp (no Date.now — keeps runs reproducible, like World). Carried
    // into hours rather than padded into the minute field: the sequence is durable now, so it passes
    // 59 on a long-lived root, and `09:100` sorts BEFORE `09:99` — which would silently reorder the
    // plan, since LIFO compensation order is a string sort on `at` (lib/engine/plan.ts).
    return new Date(Date.UTC(2026, 5, 6, 9, 0, 0) + this.seq * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  private readLedger(): number {
    if (!existsSync(this.ledgerPath)) return 0; // legitimately absent → $0
    // A present-but-unparseable ledger is a real corruption — surface it, never mask it as a valid $0.
    return (JSON.parse(readFileSync(this.ledgerPath, "utf8")) as { usd?: number }).usd ?? 0;
  }
  private writeLedger(usd: number): void {
    // The temp name must be unique PER WRITER. A single fixed `ledger.json.tmp` is shared state:
    // two processes writing at once clobber each other's temp file and the rename dies with ENOENT
    // (observed in the concurrency probe). Unique name → the rename is a genuine atomic replace.
    this.tmpSeq += 1;
    const tmp = `${this.ledgerPath}.${process.pid}.${this.tmpSeq}.tmp`;
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
    // replay-safe: deleting an already-deleted file is indistinguishable from deleting it once.
    return this.once(idemKey, "delete", true, () => {
      const p = this.filePath(path);
      if (!existsSync(p)) return false;
      rmSync(p);
      return true;
    });
  }
  restoreRow(key: string, idemKey: string): boolean {
    // replay-safe: the row is either still in trash (move it) or already back (no-op).
    return this.once(idemKey, "restore", true, () => {
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
    // NOT replay-safe: a second refund is a second movement of real money. An unresolved claim is
    // escalated as a typed JournalError rather than redone or silently reported as done.
    return this.once(idemKey, "refund", false, () => {
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
