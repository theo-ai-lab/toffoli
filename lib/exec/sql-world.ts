/**
 * Toffoli — a REAL-DATABASE-backed recovery world (a second `mode: execute` reference adapter).
 *
 * The sandbox `World` (lib/exec/world.ts) proves the recovery loop on an in-memory model; `FsWorld`
 * (lib/exec/fs-world.ts) proves it on the ACTUAL disk. `SqlWorld` proves it on a REAL relational
 * database: genuine SQL `INSERT`/`UPDATE`/`DELETE` against a `node:sqlite` store, a real soft-delete
 * trash table, a prior-value capture table that makes a destructive `UPDATE` reversible, a persisted
 * money ledger, and idempotency markers in a table — so a replayed compensation is a no-op even
 * across a *process restart* when backed by a file (the marker row survives). Those markers are
 * named after the action id, so the id counter is allocated from the database too (see `nextId`);
 * a counter that restarted with the process would let a NEW compensation inherit an old marker and
 * be skipped while reporting success. Same inverse surface (`RecoveryWorld`), so the EXACT executor
 * and safe-executor run against it unchanged; the only difference is the I/O is real SQL and
 * fallible (a locked DB / constraint error now throws, and the runtime's transient-retry +
 * circuit-breaker fire on it — see lib/runtime/resilience.ts, whose `isTransient` matches SQLite
 * "database is locked"/"busy").
 *
 * Why it stays low-maintenance and safe to leave unattended:
 *  - Everything lives in ONE database you pass in. The default is an in-memory `:memory:` DB, so a
 *    test or self-check touches no disk file at all. A real file path makes it durable.
 *  - The agent's logical "tables" are rows in a registry; the actual rows live in ONE physical table
 *    keyed by `${table}:${id}`. There is no dynamic DDL and every statement is parameterized, so an
 *    agent-supplied table/id is never interpolated into SQL — no injection surface.
 *  - It is OFF by default: Toffoli's live default remains plan-only / sandbox / escalate. A
 *    destructive `DROP TABLE` here keeps NO backup and is correctly left IRREVERSIBLE → escalated,
 *    never silently "restored" (the asymmetric-cost-correct behavior).
 *
 * ── how each damage maps to recovery ──
 *   bad DELETE → softDeleteRow captures the row in trash → classifies `delete:recoverable-copy`
 *                (REVERSIBLE) → method `restore` → restoreRow re-inserts it.
 *   bad UPDATE → updateRow captures the PRIOR value in trash → classifies
 *                `update:prior-state-captured` (REVERSIBLE) → method `restore-prior` → routed onto
 *                restoreRow by `sqlRunInverse` (the SQL-specific runInverse seam below), which writes
 *                the captured prior value back.
 *   bad DROP   → dropTable destroys the table and its rows with no backup → `sql:ddl-destructive`
 *                (IRREVERSIBLE) → escalated, left untouched.
 *
 * Zero runtime dependencies (node:sqlite only).
 */

import { DatabaseSync } from "node:sqlite";
import type { AgentAction } from "../engine/types";
import { dispatchInverse, type InverseOutcome } from "./executor";
import type { RecoveryWorld, WorldState } from "./world";

export class SqlWorld implements RecoveryWorld {
  readonly path: string;
  private readonly db: DatabaseSync;
  private seq = 0;

  // Prepared statements — built once, reused. node:sqlite parameterizes every value, so a
  // table/row id from an (untrusted) agent is bound, never concatenated into SQL.
  private readonly q: {
    insFile: ReturnType<DatabaseSync["prepare"]>;
    delFile: ReturnType<DatabaseSync["prepare"]>;
    getData: ReturnType<DatabaseSync["prepare"]>;
    upsertData: ReturnType<DatabaseSync["prepare"]>;
    delData: ReturnType<DatabaseSync["prepare"]>;
    delDataByTbl: ReturnType<DatabaseSync["prepare"]>;
    upsertTrash: ReturnType<DatabaseSync["prepare"]>;
    getTrash: ReturnType<DatabaseSync["prepare"]>;
    delTrash: ReturnType<DatabaseSync["prepare"]>;
    insTable: ReturnType<DatabaseSync["prepare"]>;
    delTable: ReturnType<DatabaseSync["prepare"]>;
    insOutbox: ReturnType<DatabaseSync["prepare"]>;
    getLedger: ReturnType<DatabaseSync["prepare"]>;
    addLedger: ReturnType<DatabaseSync["prepare"]>;
    getApplied: ReturnType<DatabaseSync["prepare"]>;
    insApplied: ReturnType<DatabaseSync["prepare"]>;
    delApplied: ReturnType<DatabaseSync["prepare"]>;
    bumpSeq: ReturnType<DatabaseSync["prepare"]>;
    selFiles: ReturnType<DatabaseSync["prepare"]>;
    selData: ReturnType<DatabaseSync["prepare"]>;
    selTrash: ReturnType<DatabaseSync["prepare"]>;
    selTables: ReturnType<DatabaseSync["prepare"]>;
    selOutbox: ReturnType<DatabaseSync["prepare"]>;
  };

  constructor(path = ":memory:") {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files      (path TEXT PRIMARY KEY, content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS data_rows  (rkey TEXT PRIMARY KEY, tbl TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trash_rows (rkey TEXT PRIMARY KEY, tbl TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tables     (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS outbox     (seq INTEGER PRIMARY KEY, line TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger     (id INTEGER PRIMARY KEY CHECK (id = 1), usd REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS applied    (marker TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS op_seq     (id INTEGER PRIMARY KEY CHECK (id = 1), next INTEGER NOT NULL);
    `);
    this.db.prepare(`INSERT OR IGNORE INTO ledger (id, usd) VALUES (1, 0)`).run();
    this.db.prepare(`INSERT OR IGNORE INTO op_seq (id, next) VALUES (1, 0)`).run();

    const p = (sql: string) => this.db.prepare(sql);
    this.q = {
      insFile: p(`INSERT INTO files (path, content) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content`),
      delFile: p(`DELETE FROM files WHERE path = ?`),
      getData: p(`SELECT rkey, tbl, value FROM data_rows WHERE rkey = ?`),
      upsertData: p(`INSERT INTO data_rows (rkey, tbl, value) VALUES (?, ?, ?) ON CONFLICT(rkey) DO UPDATE SET tbl = excluded.tbl, value = excluded.value`),
      delData: p(`DELETE FROM data_rows WHERE rkey = ?`),
      delDataByTbl: p(`DELETE FROM data_rows WHERE tbl = ?`),
      upsertTrash: p(`INSERT INTO trash_rows (rkey, tbl, value) VALUES (?, ?, ?) ON CONFLICT(rkey) DO UPDATE SET tbl = excluded.tbl, value = excluded.value`),
      getTrash: p(`SELECT rkey, tbl, value FROM trash_rows WHERE rkey = ?`),
      delTrash: p(`DELETE FROM trash_rows WHERE rkey = ?`),
      insTable: p(`INSERT OR IGNORE INTO tables (name) VALUES (?)`),
      delTable: p(`DELETE FROM tables WHERE name = ?`),
      insOutbox: p(`INSERT INTO outbox (seq, line) VALUES (?, ?)`),
      getLedger: p(`SELECT usd FROM ledger WHERE id = 1`),
      addLedger: p(`UPDATE ledger SET usd = usd + ? WHERE id = 1`),
      getApplied: p(`SELECT 1 AS x FROM applied WHERE marker = ?`),
      insApplied: p(`INSERT OR IGNORE INTO applied (marker) VALUES (?)`),
      delApplied: p(`DELETE FROM applied WHERE marker = ?`),
      // Allocate-and-read in ONE statement, so two live handles on the same file cannot both take
      // the same number the way a read-then-write pair could.
      bumpSeq: p(`UPDATE op_seq SET next = next + 1 WHERE id = 1 RETURNING next`),
      selFiles: p(`SELECT path, content FROM files ORDER BY path`),
      selData: p(`SELECT rkey, value FROM data_rows ORDER BY rkey`),
      selTrash: p(`SELECT rkey, value FROM trash_rows ORDER BY rkey`),
      selTables: p(`SELECT name FROM tables ORDER BY name`),
      selOutbox: p(`SELECT line FROM outbox ORDER BY seq`),
    };
  }

  /** Release the underlying database handle (matters for a file-backed DB; harmless for :memory:). */
  close(): void {
    this.db.close();
  }

  /**
   * Apply an inverse exactly once per idempotency key — persisted in the `applied` TABLE, so a
   * replay no-ops across a process restart (mirrors FsWorld.once()'s marker-first discipline).
   * MARKER-FIRST: claim the key BEFORE the side effect. If the side effect THROWS (a transient DB
   * fault) or no-ops, we release the claim so a legitimate retry can re-run it; if the process dies
   * in the tiny window after the claim but before the side effect, a replay safely SKIPS — the
   * asymmetric-cost-correct failure for money (a rare lost compensation beats a double refund).
   */
  private once(idemKey: string, fn: () => boolean): boolean {
    if (this.q.getApplied.get(idemKey) !== undefined) return true; // already applied → success-skip
    this.q.insApplied.run(idemKey); // claim the key first
    let ok = false;
    try {
      ok = fn();
    } catch (err) {
      this.q.delApplied.run(idemKey); // failed attempt → release the claim so a retry can re-run
      throw err; // re-throw so the runtime can classify transience and retry / trip the breaker
    }
    if (!ok) this.q.delApplied.run(idemKey); // no-op / not found → release the claim
    return ok;
  }

  /**
   * Allocate the next action number FROM THE DATABASE.
   *
   * The idempotency keys the executor uses are derived from the action id
   * (`restitution:${action.id}:${method}`) and the `applied` markers are DURABLE. So an id that
   * repeats once the database is reopened makes a brand-new compensation look like a replay of an
   * old one: `once()` finds the marker, skips the effect, and returns `true` — a restoration
   * reported for a row still in the trash, or a refund reported for money still taken. An in-memory
   * counter cannot see the ids a previous process already issued from the same file, so the counter
   * has to live where the markers live. Same reason the outbox key can no longer collide.
   *
   * Scope: this guarantees uniqueness for the life of a database created by this version. A file
   * written by an earlier version carries no record of the ids it already handed out, so its
   * counter restarts from zero — such a database must be recreated, not upgraded in place.
   */
  private nextId(): string {
    const row = this.q.bumpSeq.get() as { next: number } | undefined;
    if (row === undefined) {
      // The constructor seeds this row and the CHECK constraint keeps it singular; a missing row
      // means the database was tampered with. Failing loudly beats minting a colliding id.
      throw new Error("op_seq row is missing — this database cannot mint unique action ids");
    }
    this.seq = row.next;
    return `op${this.seq}`;
  }
  private stamp(): string {
    // deterministic monotonic timestamp (no Date.now — keeps runs reproducible, like World/FsWorld)
    return `2026-06-07T09:${String(this.seq).padStart(2, "0")}:00Z`;
  }
  private readLedger(): number {
    const row = this.q.getLedger.get() as { usd: number } | undefined;
    return row?.usd ?? 0;
  }

  // ── seed (no action emitted) ──
  seedRow(table: string, id: string, value: unknown): void {
    this.q.upsertData.run(`${table}:${id}`, table, JSON.stringify(value));
  }
  seedTable(name: string): void {
    this.q.insTable.run(name);
  }

  // ── damage operations (REAL SQL; each returns the AgentAction it represents) ──
  writeFile(path: string, content: string): AgentAction {
    this.q.insFile.run(path, content);
    return { id: this.nextId(), tool: "fs.write", op: "create", target: { kind: "file", id: path }, effect: `created ${path}`, at: this.stamp() };
  }

  /** Soft delete — captures a recoverable copy in the trash table (→ REVERSIBLE). */
  softDeleteRow(table: string, id: string): AgentAction {
    const key = `${table}:${id}`;
    const cur = this.q.getData.get(key) as { tbl: string; value: string } | undefined;
    if (cur) {
      this.q.upsertTrash.run(key, cur.tbl, cur.value);
      this.q.delData.run(key);
    }
    return { id: this.nextId(), tool: "db.execute", params: { sql: `DELETE FROM ${table} WHERE id = '${id}'` }, target: { kind: "db.row", id: key, recoverable: true }, effect: `soft-deleted ${key}`, at: this.stamp() };
  }

  /**
   * Mutate a row, CAPTURING its prior value in trash first (→ REVERSIBLE via `restore-prior`).
   * The returned action carries `target.priorState`, which is exactly what makes the classifier
   * commit to `update:prior-state-captured` instead of abstaining.
   */
  updateRow(table: string, id: string, value: unknown): AgentAction {
    const key = `${table}:${id}`;
    const cur = this.q.getData.get(key) as { tbl: string; value: string } | undefined;
    const priorState = cur ? (JSON.parse(cur.value) as unknown) : undefined;
    if (cur) this.q.upsertTrash.run(key, cur.tbl, cur.value);
    this.q.upsertData.run(key, table, JSON.stringify(value));
    return {
      id: this.nextId(),
      tool: "db.execute",
      params: { sql: `UPDATE ${table} SET value = ? WHERE id = '${id}'` },
      target: { kind: "db.row", id: key, priorState },
      effect: `updated ${key}`,
      at: this.stamp(),
    };
  }

  /** A refundable charge (→ COMPENSABLE). */
  charge(merchant: string, amountUsd: number): AgentAction {
    this.q.addLedger.run(amountUsd);
    return { id: this.nextId(), tool: "stripe.charge", op: "pay", params: { amountUsd }, target: { kind: "payment", id: merchant, externalized: false }, effect: `charged $${amountUsd} at ${merchant}`, at: this.stamp() };
  }

  /** A hard table drop with NO backup — the table and all its rows are destroyed (→ IRREVERSIBLE). */
  dropTable(name: string): AgentAction {
    this.q.delTable.run(name);
    this.q.delDataByTbl.run(name); // destroy the rows too; no trash copy → genuinely unrecoverable
    return { id: this.nextId(), tool: "db.execute", params: { sql: `DROP TABLE ${name}` }, effect: `dropped table ${name}`, at: this.stamp() };
  }

  /** An external send (→ IRREVERSIBLE — there is no un-send). */
  sendEmail(to: string, body: string): AgentAction {
    const id = this.nextId(); // one id for both the outbox row and the AgentAction — keeps the seq aligned
    this.q.insOutbox.run(this.seq, `${to}: ${body}`);
    return { id, tool: "email.send", op: "send", target: { kind: "email", externalized: true }, effect: `emailed ${to}`, at: this.stamp() };
  }

  // ── inverse operations the executor calls (idempotent per key; return true on success) ──
  deleteFile(path: string, idemKey: string): boolean {
    return this.once(idemKey, () => Number(this.q.delFile.run(path).changes) > 0);
  }

  /**
   * Restore a row from its recoverable copy in trash. Undoes BOTH a soft DELETE (the row was
   * removed from data_rows) AND an UPDATE (the row still exists but with a new value): in either
   * case the captured prior value is written back via an upsert, and the trash copy is cleared.
   */
  restoreRow(key: string, idemKey: string): boolean {
    return this.once(idemKey, () => {
      const t = this.q.getTrash.get(key) as { tbl: string; value: string } | undefined;
      if (t === undefined) return false; // nothing to undo
      this.q.upsertData.run(key, t.tbl, t.value);
      this.q.delTrash.run(key);
      return true;
    });
  }

  refund(amountUsd: number, idemKey: string): boolean {
    return this.once(idemKey, () => {
      this.q.addLedger.run(-amountUsd);
      return true;
    });
  }

  // ── inspection: read REAL DB state into the shared WorldState shape ──
  snapshot(): WorldState {
    const files: Record<string, string> = {};
    for (const r of this.q.selFiles.all() as Array<{ path: string; content: string }>) files[r.path] = r.content;

    const rows: Record<string, unknown> = {};
    for (const r of this.q.selData.all() as Array<{ rkey: string; value: string }>) rows[r.rkey] = JSON.parse(r.value);

    const trashRows: Record<string, unknown> = {};
    for (const r of this.q.selTrash.all() as Array<{ rkey: string; value: string }>) trashRows[r.rkey] = JSON.parse(r.value);

    const tables = (this.q.selTables.all() as Array<{ name: string }>).map((r) => r.name);
    const outbox = (this.q.selOutbox.all() as Array<{ line: string }>).map((r) => r.line);

    return { files, rows, trashRows, tables, ledgerUsd: this.readLedger(), outbox };
  }
}

/**
 * The SQL-specific `runInverse` seam to pass as `safeExecute(plan, world, { runInverse: sqlRunInverse })`.
 *
 * The default `dispatchInverse` only routes the three universal methods (delete / restore / refund).
 * A SQL recovery additionally needs to undo an `UPDATE`, whose planner-emitted methods
 * (`restore-prior`, `restore-version`, `rollback-transaction`) are otherwise reported `unsupported`.
 * This maps those onto `restoreRow` — which writes the captured prior value back — and DELEGATES
 * everything else (including the honest `unsupported` for a DROP with no backup) to the default
 * dispatcher, so there is exactly one mapping for the universal methods. Matches the runInverse
 * signature in lib/runtime/safe-executor.ts.
 */
export function sqlRunInverse(
  method: string,
  params: Record<string, unknown> | undefined,
  idem: string,
  world: RecoveryWorld,
): InverseOutcome {
  switch (method) {
    case "restore-prior":
    case "restore-version":
    case "rollback-transaction": {
      const id = typeof params?.["id"] === "string" ? (params["id"] as string) : undefined;
      if (!id) return { status: "unsupported", detail: `${method} without a row id — would need a real system adapter` };
      try {
        const ok = world.restoreRow(id, idem);
        return ok
          ? { status: "restored", detail: `reverted ${id} to its captured prior value` }
          : { status: "failed", detail: `revert ${id} (no captured prior / not found)` };
      } catch (err) {
        return { status: "failed", detail: (err as Error).message, error: err };
      }
    }
    default:
      return dispatchInverse(method, params, idem, world);
  }
}

// ── inline self-check (NOT a test file) — the verifier can import and call this ──────────────────

export interface SelfCheckResult {
  pass: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

/**
 * End-to-end proof on a real (in-memory) SQLite DB, with no disk and no API key:
 * seed → snapshot a pre-damage baseline → an agent does a bad DELETE / UPDATE / DROP plus a charge
 * and an external send → recover ONLY the recoverable subset through the executor's `runInverse`
 * seam (`sqlRunInverse`) → verify the recovered state matches the baseline, the irreversible
 * casualties are left untouched (never fabricated back), and replaying a compensation is a no-op.
 */
export function sqlWorldSelfCheck(): SelfCheckResult {
  const w = new SqlWorld(":memory:");
  const checks: SelfCheckResult["checks"] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  try {
    // seed two logical tables of rows
    w.seedTable("users");
    w.seedTable("logs");
    w.seedRow("users", "1", { name: "Ada", tier: "free" });
    w.seedRow("users", "2", { name: "Bo", tier: "pro" });
    w.seedRow("users", "3", { name: "Cy", tier: "free" });
    w.seedRow("logs", "1", { line: "boot ok" });

    const baseline = w.snapshot();

    // the agent does damage
    const delAct = w.softDeleteRow("users", "2"); // bad DELETE  → recoverable
    const updAct = w.updateRow("users", "1", { name: "Ada", tier: "WIPED" }); // bad UPDATE → recoverable
    w.charge("acme", 30); // COMPENSABLE
    w.dropTable("logs"); // bad DROP   → IRREVERSIBLE (table + its rows destroyed, no backup)
    w.sendEmail("ext@example.com", "oops"); // external send → IRREVERSIBLE

    const damaged = w.snapshot();
    add("damage really happened", !("users:2" in damaged.rows) && (damaged.rows["users:1"] as { tier: string }).tier === "WIPED" && !damaged.tables.includes("logs") && damaged.ledgerUsd === 30);

    // recover the recoverable subset through the real dispatch seam (what safeExecute calls)
    const restoreDel = sqlRunInverse("restore", { kind: "db.row", id: delAct.target?.id }, `restitution:${delAct.id}:restore`, w);
    const restoreUpd = sqlRunInverse("restore-prior", { id: updAct.target?.id, to: updAct.target?.priorState }, `restitution:${updAct.id}:restore-prior`, w);
    const doRefund = sqlRunInverse("refund", { amountUsd: 30 }, `restitution:charge:refund`, w);
    // the DROP has no backup → must come back UNSUPPORTED (escalated), never auto-"restored"
    const dropOutcome = sqlRunInverse("restore-from-backup", { id: "logs" }, `restitution:drop:restore-from-backup`, w);

    add("DELETE restored via restoreRow", restoreDel.status === "restored", restoreDel.detail);
    add("UPDATE reverted via restore-prior→restoreRow", restoreUpd.status === "restored", restoreUpd.detail);
    add("charge refunded", doRefund.status === "restored", doRefund.detail);
    add("DROP left unsupported (escalated, not fabricated)", dropOutcome.status === "unsupported", dropOutcome.detail);

    const after = w.snapshot();

    // recoverable subset matches the pre-damage baseline (exclude the irreversibly dropped table)
    const expectedRows = { ...baseline.rows };
    delete expectedRows["logs:1"]; // the drop is irreversible — it is NOT expected to come back
    add("recoverable rows match baseline", JSON.stringify(after.rows) === JSON.stringify(expectedRows), JSON.stringify(after.rows));
    add("ledger net back to baseline", after.ledgerUsd === baseline.ledgerUsd, `after=${after.ledgerUsd}`);
    add("trash drained after recovery", Object.keys(after.trashRows).length === 0);

    // restraint: the irreversible casualties stay gone / present, untouched by recovery
    add("dropped table stays dropped", !after.tables.includes("logs") && !("logs:1" in after.rows));
    add("sent email stays in outbox", after.outbox.length === 1 && after.outbox[0] === "ext@example.com: oops");

    // idempotency: replaying a compensation with the SAME key is a success-skip, never a double effect
    const refundReplay = w.refund(30, `restitution:charge:refund`);
    const restoreReplay = w.restoreRow(delAct.target?.id ?? "", `restitution:${delAct.id}:restore`);
    add("idempotent replay no-ops", refundReplay === true && restoreReplay === true && w.snapshot().ledgerUsd === baseline.ledgerUsd);
  } catch (err) {
    add("threw", false, (err as Error).message);
  } finally {
    w.close();
  }

  return { pass: checks.every((c) => c.ok), checks };
}

/** Render the self-check as a short report (mirrors the lib/exec/*-recover.ts entrypoint style). */
export function renderSelfCheck(r: SelfCheckResult): string {
  const lines = [
    `  ${"=".repeat(72)}`,
    "  TOFFOLI — SqlWorld self-check (real node:sqlite DB, :memory:, no disk / no API key)",
    `  ${"=".repeat(72)}`,
    ...r.checks.map((c) => `  ${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : `  — ${c.detail ?? ""}`}`),
    `  ${"-".repeat(72)}`,
    `  RESULT: ${r.pass ? "PASS" : "FAIL"} (${r.checks.filter((c) => c.ok).length}/${r.checks.length} checks)`,
    `  ${"=".repeat(72)}`,
  ];
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = sqlWorldSelfCheck();
  console.log(renderSelfCheck(r));
  if (!r.pass) process.exitCode = 1;
}
