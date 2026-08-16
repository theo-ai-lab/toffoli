/**
 * Toffoli — GUIDE-GATED ADVERSARIAL COUNTEREXAMPLE SEARCH for classifier UNDER-CALLS.
 *
 * This is the empirical complement to the mechanized Lean soundness proof (formal/). The
 * proof establishes NO-UNDER-CALL over an ABSTRACT model of the classifier: the effective class is
 * never strictly SAFER than the truth (calling an irreversible action recoverable is the one
 * catastrophic error). But the proof, like every proof, has an assumption it
 * does not discharge: it assumes the OP-RESOLUTION layer (the regexes that map a raw tool name / SQL
 * string / HTTP method to a canonical `ActionOp`, plus the metadata edges on `target`) is correct.
 * The Lean model takes the resolved op as a given.
 *
 * So this search deliberately attacks exactly that seam. It does NOT re-test the class logic the proof
 * already covers; it stresses the SURFACE→class mapping by generating thousands of actions whose true
 * reversibility is fixed by SEMANTIC FACTS, then rendering those facts into adversarial SURFACE forms
 * (real SQL with case / whitespace / transaction / CTE / comment variation; tool-name synonyms with
 * separator and casing variants; settlement / externalized metadata edges; weird params), and checking
 * that `classifyDeterministic` (abstain ↦ IRREVERSIBLE, the product fail-safe lens) never resolves a
 * surface to a class SAFER than the fact-based truth.
 *
 * ── WHY THE TRUE-CLASS ORACLE IS INDEPENDENT ──
 * `independentTrueClass()` derives the class from a structured `SemanticFacts` record (what the action
 * REALLY does), NOT by parsing the action's surface. `classifyDeterministic()` derives the class by
 * parsing the surface. They share the one correct reversibility *semantics* (there is only one), but
 * they are independent *implementations over independent inputs* — facts vs. surface — which is exactly
 * what makes their disagreement meaningful: a disagreement in the unsafe direction is an op-resolution
 * bug, not a tautology. `independentTrueClass()` returns a conservative LOWER BOUND on the true
 * severity, so a flagged violation (`effective < trueClass`) always implies a genuine under-call
 * (`effective < trueClass ≤ real`) — the search never reports a false counterexample.
 *
 * ── WHAT THIS SEARCH DISCLOSES ──
 * The fair sweep (well-formed surfaces, where op-resolution has an honest signal to read) finds ZERO
 * under-calls — the empirical complement holds on the domain the proof models, and by design the fuzzer
 * surfaces nothing in-scope. The op-resolution gaps are therefore NOT fuzzer-discovered: SIX cases are
 * HAND-AUTHORED in `KNOWN_OP_RESOLUTION_GAPS`, then re-classified live by `reproduceKnownGaps()` so each
 * is verified to still genuinely under-call, and reported (never masked). They fall in two families — a
 * LEADING SQL COMMENT, and a MULTI-STATEMENT DML behind a leading read verb — both of which hide a
 * destructive verb from `isDestructiveDdl`/`sqlVerb`, after which op-resolution falls back to the
 * (read-named) tool and under-calls a destructive statement to NULLIPOTENT/REVERSIBLE.
 *
 * Zero runtime dependencies beyond fast-check (a devDependency) + the engine classifier + memory.ts.
 */

import fc from "fast-check";
import { classifyDeterministic } from "../engine/classify";
import { REVERSIBILITY_ORDER, type AgentAction, type Classification, type Reversibility } from "../engine/types";
import { faultSignature } from "./memory";

// ── severity + the product fail-safe lens ────────────────────────────────────────

export function severityOf(c: Reversibility): number {
  return REVERSIBILITY_ORDER.indexOf(c);
}

/** The effective class an operator actually gets: an abstention (null) fails safe to IRREVERSIBLE. */
export function effectiveClass(action: AgentAction, classify = classifyDeterministic): Reversibility {
  return classify(action)?.class ?? "IRREVERSIBLE";
}

// ── the INDEPENDENT, fact-based true-class oracle ────────────────────────────────

/**
 * The semantic facts of an action — the GROUND TRUTH of what it really does. The renderer turns these
 * into an adversarial surface; the oracle turns these into a true class. Neither reads the other's view.
 */
export interface SemanticFacts {
  effect: "read" | "create" | "update" | "delete" | "append" | "send" | "pay" | "publish" | "deploy";
  /** Did a durable change commit? `false` ⇒ nothing to undo. Defaults true. */
  committed?: boolean;
  /** Crossed a trust boundary to a party you don't control (send / pay / publish / create). */
  externalized?: boolean;
  /** An INDEPENDENT recoverable copy exists (delete / destructive-DDL / update). */
  recoverable?: boolean;
  /** The before-image was captured (update). */
  priorStateKnown?: boolean;
  /** Inside an open (un-committed) transaction — a ROLLBACK restores it. */
  inOpenTransaction?: boolean;
  /** A DROP / TRUNCATE (destroys structure + rows), not an ordinary row delete. */
  destructiveDdl?: boolean;
  /** A DROP DATABASE / SCHEMA / TABLESPACE — never recoverable, not even in a transaction. */
  dropsDatabase?: boolean;
}

/**
 * A conservative LOWER BOUND on the true reversibility severity, derived purely from semantic facts.
 * This is NOT a second copy of the classifier — it never parses a tool name or SQL string; it reads
 * the facts directly. Where the honest truth is genuinely uncertain (an update with no before-image,
 * a payment of unknown settlement) it returns the LEAST severe defensible class, so the no-under-call
 * assertion (`effective ≥ trueClass`) can never produce a false positive.
 */
export function independentTrueClass(f: SemanticFacts): Reversibility {
  if (f.committed === false) return "NULLIPOTENT"; // no durable effect → nothing to undo
  switch (f.effect) {
    case "read":
      return "NULLIPOTENT";
    case "append":
      return "COMPENSABLE"; // no un-append; only a correcting entry
    case "deploy":
      return "COMPENSABLE"; // rollback compensates
    case "create":
      return f.externalized ? "COMPENSABLE" : "REVERSIBLE";
    case "update":
      // exact restore only with a captured prior / version history; otherwise at best compensable
      return f.priorStateKnown || f.recoverable ? "REVERSIBLE" : "COMPENSABLE";
    case "send":
      return f.externalized === false ? "REVERSIBLE" : "IRREVERSIBLE"; // delivered ⇒ no un-send
    case "pay":
      // settled/withdrawn ⇒ gone; refundable window ⇒ compensable; unknown ⇒ conservative lower bound
      return f.externalized === true ? "IRREVERSIBLE" : "COMPENSABLE";
    case "publish":
      return f.externalized === true ? "IRREVERSIBLE" : "COMPENSABLE";
    case "delete":
      if (f.destructiveDdl) {
        if (f.dropsDatabase) return "IRREVERSIBLE";
        if (f.inOpenTransaction) return "REVERSIBLE";
        if (f.recoverable) return "COMPENSABLE";
        return "IRREVERSIBLE";
      }
      if (f.recoverable || f.inOpenTransaction) return "REVERSIBLE";
      return "IRREVERSIBLE";
  }
}

// ── a search case + a found counterexample ───────────────────────────────────────

export interface SearchCase {
  action: AgentAction;
  trueClass: Reversibility;
  /** A short label for coverage diagnostics ("sql.delete", "tool.send", "metadata.pay", …). */
  profile: string;
}

export interface Counterexample {
  profile: string;
  action: AgentAction;
  /** The fact-based true (lower-bound) class. */
  trueClass: Reversibility;
  /** What the classifier actually assigned (abstain ↦ IRREVERSIBLE). */
  assignedClass: Reversibility;
  /** The raw classification, or null on an abstention. */
  classification: Classification | null;
  /** How many severity buckets too SAFE the assignment was (≥1 for a real under-call). */
  severityGap: number;
  /** A precise, human-legible account of the under-call and the surface that caused it. */
  rationale: string;
  /** The shape-based fault signature of the offending action — cross-references RecoveryMemory. */
  faultSignature: string;
}

function toCounterexample(c: SearchCase, classify: typeof classifyDeterministic): Counterexample | null {
  const classification = classify(c.action);
  const assignedClass = classification?.class ?? "IRREVERSIBLE";
  const gap = severityOf(c.trueClass) - severityOf(assignedClass);
  if (gap <= 0) return null; // no under-call (a match or a safe over-call)
  const how = classification ? `assigned ${assignedClass} via ${classification.ruleRef}` : `abstained → IRREVERSIBLE (so this cannot be an under-call)`;
  return {
    profile: c.profile,
    action: c.action,
    trueClass: c.trueClass,
    assignedClass,
    classification,
    severityGap: gap,
    rationale:
      `UNDER-CALL (${assignedClass} < true ${c.trueClass}, ${gap} bucket(s) too safe): tool='${c.action.tool}'` +
      `${c.action.op ? ` op='${c.action.op}'` : ""}` +
      `${c.action.params?.["sql"] ? ` sql=${JSON.stringify(c.action.params["sql"])}` : ""} — ${how}.`,
    faultSignature: faultSignature([c.action], c.action.tool),
  };
}

// ── adversarial RENDERERS: facts → surface, varying only what should not change the class ─────────

const SEPARATORS = [".", "_", "-"] as const;
/** Resource / affix tokens that contain NO classifier keyword — so they never perturb op-resolution. */
const NEUTRAL = ["orders", "widgets", "accounts", "tenants", "tickets", "metrics", "warehouse", "region", "cohort", "batch", "customers", "clusters"] as const;
const PREFIXES = ["svc", "api", "tool", "job", "fn", "handler", "worker"] as const;
/** Whitespace fillers between SQL tokens (all FAIR — `\b`/`\s` and the leading trim handle them). */
const WS = [" ", "  ", "\t", " \n ", "\n\t"] as const;

const id = fc.stringMatching(/^[a-z0-9_-]{1,10}$/);
const tableName = fc.constantFrom(...NEUTRAL);
const smallInt = fc.integer({ min: 0, max: 9999 });
/** Reserved-prefix noise params — never collide with a meaningful key (method/sql/query/name/transaction). */
const noiseParams = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 5 }).map((s) => `meta_${s}`),
  fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
  { maxKeys: 3 },
);

/** Randomly re-case a keyword (op-resolution is case-insensitive; SQL parsing must be too). */
function recase(word: string, pick: number): string {
  if (pick % 3 === 0) return word.toUpperCase();
  if (pick % 3 === 1) return word.toLowerCase();
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Build an adversarial tool name carrying exactly ONE op keyword among keyword-free affixes. */
function renderToolName(keyword: string, parts: { sep: string; prefix: string; noise: string; order: number }): string {
  const k = keyword; // separators are normalized to spaces by resolveOp
  switch (parts.order % 3) {
    case 0:
      return `${parts.prefix}${parts.sep}${k}${parts.sep}${parts.noise}`;
    case 1:
      return `${k}${parts.sep}${parts.noise}`;
    default:
      return `${parts.noise}${parts.sep}${k}`;
  }
}

const toolNameParts = fc.record({
  sep: fc.constantFrom(...SEPARATORS),
  prefix: fc.constantFrom(...PREFIXES),
  noise: fc.constantFrom(...NEUTRAL),
  order: fc.integer({ min: 0, max: 2 }),
});

interface SqlOpts {
  begin: number; // 0 none, 1 BEGIN;, 2 START TRANSACTION;
  cte: boolean;
  trailing: number; // 0 none, 1 -- comment, 2 /* comment */
  ws: string;
  recaseSeed: number;
  lead: string; // leading whitespace (FAIR — trimmed)
}
const sqlOpts = fc.record({
  begin: fc.integer({ min: 0, max: 2 }),
  cte: fc.boolean(),
  trailing: fc.integer({ min: 0, max: 2 }),
  ws: fc.constantFrom(...WS),
  recaseSeed: fc.integer({ min: 0, max: 8 }),
  lead: fc.constantFrom("", "  ", "\n", "\t ", " \n\t "),
});

/** Render a single, well-formed (FAIR) SQL statement for a write verb, with adversarial formatting. */
function renderSql(verb: "DELETE" | "UPDATE" | "INSERT" | "TRUNCATE" | "DROP" | "DROP_DB" | "SELECT" | "SHOW", table: string, n: number, o: SqlOpts): string {
  const w = o.ws;
  const kw = (s: string) => recase(s, o.recaseSeed);
  let core: string;
  let canCte = false;
  switch (verb) {
    case "DELETE":
      core = `${kw("DELETE")}${w}${kw("FROM")}${w}${table}${w}${kw("WHERE")}${w}id${w}=${w}${n}`;
      canCte = true;
      break;
    case "UPDATE":
      core = `${kw("UPDATE")}${w}${table}${w}${kw("SET")}${w}col${w}=${w}${n}`;
      canCte = true;
      break;
    case "INSERT":
      core = `${kw("INSERT")}${w}${kw("INTO")}${w}${table}${w}${kw("VALUES")}${w}(${n})`;
      canCte = true;
      break;
    case "TRUNCATE":
      core = `${kw("TRUNCATE")}${w}${kw("TABLE")}${w}${table}`;
      break;
    case "DROP":
      core = `${kw("DROP")}${w}${kw("TABLE")}${w}${table}`;
      break;
    case "DROP_DB":
      core = `${kw("DROP")}${w}${kw("DATABASE")}${w}${table}`;
      break;
    case "SELECT":
      core = `${kw("SELECT")}${w}*${w}${kw("FROM")}${w}${table}`;
      break;
    case "SHOW":
      core = `${kw("SHOW")}${w}${kw("TABLES")}`;
      break;
  }
  // CTE wrap (data-modifying CTE) — only for write DML, only when it preserves the verb's semantics.
  if (o.cte && canCte && (verb === "DELETE" || verb === "UPDATE" || verb === "INSERT")) {
    const inner = verb === "DELETE" ? `${kw("DELETE")}${w}${kw("FROM")}${w}${table}${w}${kw("RETURNING")}${w}*`
      : verb === "UPDATE" ? `${kw("UPDATE")}${w}${table}${w}${kw("SET")}${w}col${w}=${w}${n}${w}${kw("RETURNING")}${w}*`
      : `${kw("INSERT")}${w}${kw("INTO")}${w}${table}${w}${kw("VALUES")}${w}(${n})${w}${kw("RETURNING")}${w}*`;
    core = `${kw("WITH")}${w}cte${w}${kw("AS")}${w}(${inner})${w}${kw("SELECT")}${w}1`;
  }
  // FAIR: a single leading transaction-control keyword the resolver is expected to strip.
  const begin = o.begin === 1 ? `${kw("BEGIN")};${w}` : o.begin === 2 ? `${kw("START")}${w}${kw("TRANSACTION")};${w}` : "";
  // FAIR: a TRAILING comment (the verb still leads). A LEADING comment is the disclosed gap — never here.
  const trailing = o.trailing === 1 ? ` -- ${table}` : o.trailing === 2 ? ` /* ${table} */` : "";
  return `${o.lead}${begin}${core}${trailing}`;
}

// ── the generators: one per attack surface, each yielding {action, trueClass} ─────

/** Whether to declare `op` (short-circuits resolution) or leave it for inference (the attack surface). */
const declareOp = fc.boolean();

function withNoise(action: AgentAction, noise: Record<string, unknown>): AgentAction {
  return { ...action, params: { ...noise, ...(action.params ?? {}) } };
}

/** SQL-driven cases: the destructive verb is the ground truth; the surface formatting is adversarial. */
const sqlCase: fc.Arbitrary<SearchCase> = fc
  .record({
    kind: fc.constantFrom("delete", "update", "insert", "truncate", "drop", "drop_db", "select", "show") as fc.Arbitrary<
      "delete" | "update" | "insert" | "truncate" | "drop" | "drop_db" | "select" | "show"
    >,
    recoverable: fc.option(fc.boolean(), { nil: undefined }),
    priorStateKnown: fc.boolean(),
    inOpenTransaction: fc.boolean(),
    table: tableName,
    n: smallInt,
    o: sqlOpts,
    tool: fc.constantFrom("db.execute", "db.query", "sql.run", "database.exec", "pg.query"),
    noise: noiseParams,
    aid: id,
  })
  .map((r): SearchCase => {
    const facts: SemanticFacts = { effect: "read", committed: true };
    let sql: string;
    switch (r.kind) {
      case "delete":
        facts.effect = "delete";
        facts.recoverable = r.recoverable;
        facts.inOpenTransaction = r.inOpenTransaction;
        sql = renderSql("DELETE", r.table, r.n, r.o);
        break;
      case "update":
        facts.effect = "update";
        facts.recoverable = r.recoverable;
        facts.priorStateKnown = r.priorStateKnown;
        sql = renderSql("UPDATE", r.table, r.n, r.o);
        break;
      case "insert":
        facts.effect = "create";
        sql = renderSql("INSERT", r.table, r.n, r.o);
        break;
      case "truncate":
        facts.effect = "delete";
        facts.destructiveDdl = true;
        facts.recoverable = r.recoverable;
        facts.inOpenTransaction = r.inOpenTransaction;
        sql = renderSql("TRUNCATE", r.table, r.n, r.o);
        break;
      case "drop":
        facts.effect = "delete";
        facts.destructiveDdl = true;
        facts.recoverable = r.recoverable;
        facts.inOpenTransaction = r.inOpenTransaction;
        sql = renderSql("DROP", r.table, r.n, r.o);
        break;
      case "drop_db":
        facts.effect = "delete";
        facts.destructiveDdl = true;
        facts.dropsDatabase = true;
        facts.inOpenTransaction = r.inOpenTransaction;
        sql = renderSql("DROP_DB", r.table, r.n, r.o);
        break;
      case "select":
        facts.effect = "read";
        sql = renderSql("SELECT", r.table, r.n, r.o);
        break;
      case "show":
        facts.effect = "read";
        sql = renderSql("SHOW", r.table, r.n, r.o);
        break;
    }
    const params: Record<string, unknown> = { sql };
    if (facts.inOpenTransaction) params["transaction"] = "open";
    const target =
      facts.recoverable !== undefined ? { kind: "db.row", id: `${r.table}:${r.n}`, recoverable: facts.recoverable } : undefined;
    const action: AgentAction = withNoise({ id: `sql-${r.aid}`, tool: r.tool, params, ...(target ? { target } : {}) }, r.noise);
    return { action, trueClass: independentTrueClass(facts), profile: `sql.${r.kind}` };
  });

const SEND_KW = ["email", "e-mail", "mail", "smtp", "sendgrid", "postmark", "ses", "mailgun", "sms", "twilio", "slack", "discord", "telegram", "webhook", "notify", "push"];
const PAY_KW = ["stripe", "charge", "payment", "payout", "invoice", "billing", "transfer", "ach", "wire"];
const PUBLISH_KW = ["publish", "broadcast", "post-tweet", "post-feed", "go-live"];
const DEPLOY_KW = ["deploy", "release", "rollout", "terraform", "kubectl", "helm", "provision"];
const CREATE_KW = ["create", "insert", "add", "upload", "mkdir", "write"];
const DELETE_KW = ["delete", "remove", "destroy", "drop", "purge", "wipe", "rm"];
const APPEND_KW = ["append", "log", "emit", "enqueue"];
const READ_KW = ["read", "get", "list", "fetch", "search", "select", "query", "describe"];
const UPDATE_KW = ["update", "patch", "edit", "modify", "set", "replace", "rename", "move"];

/** Tool-name-driven cases: the op keyword + target metadata are the truth; the name spelling is adversarial. */
const toolNameCase: fc.Arbitrary<SearchCase> = fc
  .record({
    effect: fc.constantFrom("send", "pay", "publish", "deploy", "create", "delete", "append", "read", "update") as fc.Arbitrary<SemanticFacts["effect"]>,
    externalized: fc.option(fc.boolean(), { nil: undefined }),
    recoverable: fc.option(fc.boolean(), { nil: undefined }),
    priorStateKnown: fc.boolean(),
    parts: toolNameParts,
    kwPick: fc.integer({ min: 0, max: 100 }),
    keywordInName: fc.boolean(),
    declare: declareOp,
    noise: noiseParams,
    aid: id,
  })
  .map((r): SearchCase => {
    const pools: Record<SemanticFacts["effect"], string[]> = {
      send: SEND_KW,
      pay: PAY_KW,
      publish: PUBLISH_KW,
      deploy: DEPLOY_KW,
      create: CREATE_KW,
      delete: DELETE_KW,
      append: APPEND_KW,
      read: READ_KW,
      update: UPDATE_KW,
    };
    const pool = pools[r.effect];
    const keyword = pool[r.kwPick % pool.length]!;
    const facts: SemanticFacts = { effect: r.effect, committed: true };
    // attach only the metadata edges that matter for this effect's class
    if (r.effect === "send" || r.effect === "pay" || r.effect === "publish" || r.effect === "create") facts.externalized = r.externalized;
    if (r.effect === "delete" || r.effect === "update") facts.recoverable = r.recoverable;
    if (r.effect === "update") facts.priorStateKnown = r.priorStateKnown;

    // Canonical op the keyword denotes — used only when declaring op (still semantics-consistent).
    const opFor: Record<SemanticFacts["effect"], AgentAction["op"]> = {
      send: "send",
      pay: "pay",
      publish: "publish",
      deploy: "deploy",
      create: "create",
      delete: "delete",
      append: "append",
      read: "read",
      update: "update",
    };

    const target =
      facts.externalized !== undefined || facts.recoverable !== undefined
        ? {
            kind: r.effect === "pay" ? "payment" : r.effect === "send" ? "email" : r.effect === "publish" ? "post" : "resource",
            id: `${r.parts.noise}-${r.aid}`,
            ...(facts.externalized !== undefined ? { externalized: facts.externalized } : {}),
            ...(facts.recoverable !== undefined ? { recoverable: facts.recoverable } : {}),
            ...(facts.priorStateKnown ? { priorState: { col: 1 } } : {}),
          }
        : facts.priorStateKnown
          ? { kind: "resource", id: r.aid, priorState: { col: 1 } }
          : undefined;

    // Adversarial placement: keyword in the TOOL name, or hidden in params.name behind a neutral tool.
    const toolName = renderToolName(keyword, r.parts);
    const base: AgentAction = r.keywordInName
      ? { id: `tool-${r.aid}`, tool: toolName, ...(target ? { target } : {}) }
      : { id: `tool-${r.aid}`, tool: `${r.parts.prefix}.run`, params: { name: toolName }, ...(target ? { target } : {}) };
    const action: AgentAction = withNoise(r.declare ? { ...base, op: opFor[r.effect] } : base, r.noise);
    return { action, trueClass: independentTrueClass(facts), profile: `tool.${r.effect}` };
  });

/** HTTP-method-driven cases: the method is the truth; surrounding params are noise. */
const httpCase: fc.Arbitrary<SearchCase> = fc
  .record({
    method: fc.constantFrom("GET", "HEAD", "OPTIONS", "TRACE", "POST", "PUT", "PATCH", "DELETE"),
    externalized: fc.option(fc.boolean(), { nil: undefined }),
    recoverable: fc.option(fc.boolean(), { nil: undefined }),
    casing: fc.boolean(),
    noise: noiseParams,
    aid: id,
  })
  .map((r): SearchCase => {
    const map: Record<string, SemanticFacts["effect"]> = { GET: "read", HEAD: "read", OPTIONS: "read", TRACE: "read", POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" };
    const effect = map[r.method]!;
    const facts: SemanticFacts = { effect, committed: true };
    if (effect === "create") facts.externalized = r.externalized;
    if (effect === "delete") facts.recoverable = r.recoverable;
    if (effect === "update") {
      facts.recoverable = r.recoverable;
      // a PUT/PATCH whose prior is unknown is honestly at best compensable (lower bound handled by oracle)
    }
    const method = r.casing ? r.method.toLowerCase() : r.method;
    const target =
      facts.externalized !== undefined || facts.recoverable !== undefined
        ? { kind: "http", id: r.aid, ...(facts.externalized !== undefined ? { externalized: facts.externalized } : {}), ...(facts.recoverable !== undefined ? { recoverable: facts.recoverable } : {}) }
        : undefined;
    const action: AgentAction = withNoise({ id: `http-${r.aid}`, tool: "http.request", params: { method, url: `https://api/${r.aid}` }, ...(target ? { target } : {}) }, r.noise);
    return { action, trueClass: independentTrueClass(facts), profile: `http.${effect}` };
  });

/** Uncommitted cases: a dry-run / rolled-back call of ANY effect is NULLIPOTENT (rule 0). */
const uncommittedCase: fc.Arbitrary<SearchCase> = fc
  .record({ effect: fc.constantFrom("delete", "send", "pay", "update", "create") as fc.Arbitrary<SemanticFacts["effect"]>, aid: id, noise: noiseParams })
  .map((r): SearchCase => {
    const action: AgentAction = withNoise({ id: `unc-${r.aid}`, tool: "db.execute", op: r.effect, committed: false }, r.noise);
    return { action, trueClass: independentTrueClass({ effect: r.effect, committed: false }), profile: "uncommitted" };
  });

/** The combined fair adversarial distribution. */
export const fairCase: fc.Arbitrary<SearchCase> = fc.oneof(
  { weight: 5, arbitrary: sqlCase },
  { weight: 5, arbitrary: toolNameCase },
  { weight: 2, arbitrary: httpCase },
  { weight: 1, arbitrary: uncommittedCase },
);

// ── semantics-preserving mutation (for seeding from recorded faults) ──────────────

/**
 * Mutate a case's SURFACE while preserving its true class — re-cases an embedded SQL verb, injects
 * whitespace, appends a trailing comment, and adds noise params. Used to amplify a recorded fault
 * (e.g. an action recovered against a RecoveryMemory fault signature) into many adversarial variants.
 */
export function mutateCase(c: SearchCase, rng: () => number): SearchCase {
  const a = c.action;
  const params = { ...(a.params ?? {}) };
  const sql = typeof params["sql"] === "string" ? (params["sql"] as string) : undefined;
  if (sql) {
    let s = sql;
    if (rng() < 0.5) s = s.replace(/\b(DELETE|UPDATE|INSERT|DROP|TRUNCATE|SELECT)\b/i, (m) => (rng() < 0.5 ? m.toUpperCase() : m.toLowerCase()));
    if (rng() < 0.5) s = s.replace(/ /g, "  ");
    if (rng() < 0.5) s = `${s} /* note */`;
    params["sql"] = s;
  }
  params[`meta_${Math.floor(rng() * 1e6).toString(36)}`] = rng() < 0.5 ? "x" : Math.floor(rng() * 1000);
  return { ...c, action: { ...a, id: `${a.id}~m${Math.floor(rng() * 1e6).toString(36)}`, params } };
}

// ── the search ────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  /** How many generated cases to draw. Default 2000. */
  count?: number;
  /** fast-check seed — fix it for a deterministic, reproducible sweep. Default 0xC0FFEE. */
  seed?: number;
  /** Recorded fault cases (e.g. from a RecoveryMemory-tracked run); each is mutated into variants. */
  seeds?: SearchCase[];
  /** Mutations per seed. Default 8. */
  mutationsPerSeed?: number;
  /** The classifier under test. Defaults to the deterministic floor. */
  classify?: typeof classifyDeterministic;
}

export interface SearchResult {
  casesRun: number;
  /** Every genuine under-call found (empty on the fair distribution). */
  underCalls: Counterexample[];
  /** trueClass distribution actually exercised (non-vacuity). */
  classesSeen: Record<Reversibility, number>;
  /** profile → count. */
  profilesSeen: Record<string, number>;
  /** Cases where the classifier safely OVER-called (effective strictly more severe than truth). */
  strictOverCalls: number;
  /** Cases where the classifier abstained (effective lensed to IRREVERSIBLE). */
  abstentions: number;
  seed: number;
}

/**
 * Run the adversarial sweep. Draws `count` fair cases (deterministically, by `seed`) plus mutated
 * variants of any `seeds`, classifies each, and collects every genuine under-call. A non-empty
 * `underCalls` is a real classifier bug to report — never something to silence.
 */
export function searchCounterexamples(opts: SearchOptions = {}): SearchResult {
  const count = opts.count ?? 2000;
  const seed = opts.seed ?? 0xc0ffee;
  const classify = opts.classify ?? classifyDeterministic;

  const cases = fc.sample(fairCase, { numRuns: count, seed });
  // amplify recorded faults
  if (opts.seeds?.length) {
    const per = opts.mutationsPerSeed ?? 8;
    let rngState = seed >>> 0;
    const rng = () => {
      // a tiny deterministic LCG so seeding is reproducible without another fast-check pass
      rngState = (rngState * 1664525 + 1013904223) >>> 0;
      return rngState / 0x100000000;
    };
    for (const s of opts.seeds) {
      cases.push(s);
      for (let i = 0; i < per; i++) cases.push(mutateCase(s, rng));
    }
  }

  const underCalls: Counterexample[] = [];
  const classesSeen: Record<Reversibility, number> = { NULLIPOTENT: 0, REVERSIBLE: 0, COMPENSABLE: 0, IRREVERSIBLE: 0 };
  const profilesSeen: Record<string, number> = {};
  let strictOverCalls = 0;
  let abstentions = 0;

  for (const c of cases) {
    classesSeen[c.trueClass]++;
    profilesSeen[c.profile] = (profilesSeen[c.profile] ?? 0) + 1;
    const classification = classify(c.action);
    if (classification === null) abstentions++;
    const assigned = classification?.class ?? "IRREVERSIBLE";
    if (severityOf(assigned) > severityOf(c.trueClass)) strictOverCalls++;
    const ce = toCounterexample(c, classify);
    if (ce) underCalls.push(ce);
  }

  return { casesRun: cases.length, underCalls, classesSeen, profilesSeen, strictOverCalls, abstentions, seed };
}

// ── the DISCLOSED GAP: genuine op-resolution under-calls, reported (never masked) ─────────────

export interface KnownGap {
  id: string;
  action: AgentAction;
  /** The fact-based true class (defensible lower bound). */
  trueClass: Reversibility;
  /** Why this is a genuine op-resolution bug, and the root cause in classify.ts. */
  note: string;
}

/**
 * Curated, reproducible counterexamples the search has DISCLOSED in the op-resolution layer the Lean
 * proof assumes correct. These are NOT in the fair sweep — they are the proof's undischarged
 * assumption, made concrete. Root cause: op-resolution reads only the LEADING verb (`sqlVerb` bails on
 * a leading non-letter prefix; `isDestructiveDdl` covers only DROP/TRUNCATE, not DML), so a destructive
 * verb hidden behind a leading comment OR behind a leading read statement is missed, and resolution
 * falls back to the (read-named) tool — under-calling a destructive statement to NULLIPOTENT/REVERSIBLE.
 *
 * If `reproduceKnownGaps()` ever reports one of these as NO LONGER under-calling, the gap was closed in
 * classify.ts — promote that case into the fair sweep.
 */
export const KNOWN_OP_RESOLUTION_GAPS: KnownGap[] = [
  {
    id: "leading-block-comment-drop",
    action: { id: "gap-a1", tool: "db.query", params: { sql: "/* trace-7f */ DROP TABLE orders" } },
    trueClass: "IRREVERSIBLE",
    note: "leading /* */ comment defeats isDestructiveDdl (no leading `^\\s*DROP`, no `;DROP`) AND sqlVerb (no leading letter) → falls back to tool 'db.query' → read → NULLIPOTENT",
  },
  {
    id: "leading-line-comment-drop",
    action: { id: "gap-a2", tool: "db.query", params: { sql: "-- nightly cleanup\nDROP TABLE orders" } },
    trueClass: "IRREVERSIBLE",
    note: "leading -- line comment hides the DROP from both detectors → tool 'db.query' → read → NULLIPOTENT",
  },
  {
    id: "leading-comment-delete",
    action: { id: "gap-a3", tool: "db.select", params: { sql: "/* audit */ DELETE FROM orders WHERE 1=1" } },
    trueClass: "IRREVERSIBLE",
    note: "leading comment hides the DELETE; isDestructiveDdl does not cover DML anyway → tool 'db.select' → read → NULLIPOTENT",
  },
  {
    id: "multi-stmt-select-then-delete",
    action: { id: "gap-b1", tool: "db.query", params: { sql: "SELECT 1; DELETE FROM orders" } },
    trueClass: "IRREVERSIBLE",
    note: "multi-statement DML: sqlVerb reads only the leading SELECT; isDestructiveDdl covers only DROP/TRUNCATE, not DELETE → op read → NULLIPOTENT",
  },
  {
    id: "multi-stmt-select-then-update",
    action: { id: "gap-b2", tool: "db.query", params: { sql: "SELECT 1; UPDATE orders SET balance = 0" } },
    trueClass: "COMPENSABLE",
    note: "leading SELECT masks a trailing UPDATE (no before-image) → op read → NULLIPOTENT (an under-call of an at-best-compensable write)",
  },
  {
    id: "multi-stmt-insert-then-delete",
    action: { id: "gap-b3", tool: "db.execute", params: { sql: "INSERT INTO orders VALUES (1); DELETE FROM orders" } },
    trueClass: "IRREVERSIBLE",
    note: "leading INSERT masks a trailing hard DELETE → op create → REVERSIBLE (an under-call of an irreversible statement)",
  },
];

/** Classify the disclosed-gap cases live and return the ones that genuinely under-call (the report). */
export function reproduceKnownGaps(classify = classifyDeterministic): Counterexample[] {
  const out: Counterexample[] = [];
  for (const g of KNOWN_OP_RESOLUTION_GAPS) {
    const ce = toCounterexample({ action: g.action, trueClass: g.trueClass, profile: `known-gap:${g.id}` }, classify);
    if (ce) out.push({ ...ce, rationale: `${ce.rationale}  ROOT CAUSE: ${g.note}` });
  }
  return out;
}
