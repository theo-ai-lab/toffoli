/**
 * Toffoli — the deterministic reversibility classifier (v1).
 *
 * Takes an `AgentAction` and returns a `Classification` (class + the rule that
 * proves it), OR abstains (`null`) and routes the action to the gated LLM judge.
 * Deterministic rules ONLY — no model is consulted here. The classifier is exact
 * where reversibility is a matter of mechanics (an external send can't be un-sent;
 * a `DROP TABLE` with no backup is gone) and abstains where it genuinely depends
 * on semantics (`execute` arbitrary code; an `update` whose prior value is unknown).
 *
 * Zero dependencies. Every `Classification` cites a `ruleRef` and a `rationale`
 * (the citation invariant), and ambiguous calls fail TOWARD the severe class.
 */

import type { AgentAction, ActionOp, Classification, Reversibility } from "./types";

// ── small, safe readers over the loosely-typed params bag ──────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function param(action: AgentAction, key: string): unknown {
  return action.params ? action.params[key] : undefined;
}

/** The HTTP method, upper-cased, if this looks like an HTTP call. */
function httpMethod(action: AgentAction): string | undefined {
  const m = str(param(action, "method"));
  return m ? m.toUpperCase() : undefined;
}

const SQL_WRITE = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP)\b/i;

/**
 * The effective SQL verb. Strips a leading transaction-control keyword so a wrapped verb is
 * still seen ("BEGIN; DROP …"), and resolves a data-modifying CTE (`WITH … DELETE/UPDATE/INSERT`)
 * to its inner write — a writing CTE is NEVER a read (the Postgres data-modifying-CTE case).
 */
function sqlVerb(action: AgentAction): string | undefined {
  let sql = (str(param(action, "sql")) ?? str(param(action, "query")))?.trim();
  if (!sql) return undefined;
  sql = sql.replace(/^(BEGIN|START\s+TRANSACTION)\s*;?\s*/i, "");
  const lead = sql.match(/^[a-zA-Z]+/)?.[0]?.toUpperCase();
  if (!lead) return undefined;
  if (lead !== "WITH") return lead;
  const w = sql.match(SQL_WRITE);
  return w?.[1]?.toUpperCase() ?? "SELECT"; // a read-only CTE stays a read
}

const HTTP_OP: Record<string, ActionOp> = {
  GET: "read",
  HEAD: "read",
  OPTIONS: "read",
  TRACE: "read",
  POST: "create",
  PUT: "update",
  PATCH: "update",
  DELETE: "delete",
};

const SQL_OP: Record<string, ActionOp> = {
  SELECT: "read",
  SHOW: "read",
  EXPLAIN: "read",
  INSERT: "create",
  UPDATE: "update",
  MERGE: "update", // MERGE can insert/update/delete rows — treat as a write, never a read
  DELETE: "delete",
  TRUNCATE: "delete",
  DROP: "delete",
};

/** Tool-name heuristics, tried in order. First match wins. */
const TOOL_PATTERNS: Array<[RegExp, ActionOp]> = [
  [/\b(email|e-mail|mail|smtp|sendgrid|postmark|ses|mailgun)\b/i, "send"],
  [/\b(sms|twilio|slack|discord|telegram|webhook|notify|push|publish.?message)\b/i, "send"],
  [/\b(stripe|charge|payment|payout|invoice|billing|refund|transfer|ach|wire)\b/i, "pay"],
  [/\b(deploy|release|rollout|terraform|kubectl|helm|provision)\b/i, "deploy"],
  [/\b(publish|broadcast|post.?(tweet|feed|blog|cms)|go.?live)\b/i, "publish"],
  [/\b(exec|execute|shell|command|run.?(code|script)|eval|bash)\b/i, "execute"],
  [/\b(delete|remove|destroy|drop|purge|wipe|rm)\b/i, "delete"],
  [/\b(update|patch|edit|modify|set|replace|rename|move)\b/i, "update"],
  [/\b(append|log|emit|enqueue)\b/i, "append"],
  [/\b(create|insert|add|upload|write|mkdir|provision.?file)\b/i, "create"],
  [/\b(read|get|list|fetch|search|select|query|describe)\b/i, "read"],
];

/** Resolve the canonical op, and the citation for how we got it. */
function resolveOp(action: AgentAction): { op: ActionOp; opRef: string } {
  if (action.op) return { op: action.op, opRef: "op:declared" };

  const method = httpMethod(action);
  if (method && HTTP_OP[method]) {
    return { op: HTTP_OP[method], opRef: `RFC9110:method=${method}` };
  }
  const verb = sqlVerb(action);
  if (verb && SQL_OP[verb]) {
    return { op: SQL_OP[verb], opRef: `sql:verb=${verb}` };
  }
  // Normalize separators ('.', '_', '-') to spaces so word boundaries fire on each segment
  // (e.g. "search_web" → "search web"); '_' is a word char, so \bsearch\b won't match it raw.
  const hay = `${action.tool} ${str(param(action, "name")) ?? ""}`.replace(/[^a-zA-Z0-9]+/g, " ");
  for (const [re, op] of TOOL_PATTERNS) {
    if (re.test(hay)) return { op, opRef: `tool-name:~/${re.source}/` };
  }
  return { op: "custom", opRef: "op:unrecognized" };
}

// ── helpers reused across rules ────────────────────────────────────────────────

function isDestructiveDdl(action: AgentAction): boolean {
  // Scan every statement boundary, not just the leading verb, so a wrapped or multi-statement
  // destructive DDL ("BEGIN; DROP TABLE x") is still caught.
  const sql = str(param(action, "sql")) ?? str(param(action, "query")) ?? "";
  return /(^|;)\s*(DROP|TRUNCATE)\b/i.test(sql);
}

/** A DML statement still inside an open (un-committed) transaction can be rolled back. */
function inOpenTransaction(action: AgentAction): boolean {
  return str(param(action, "transaction")) === "open";
}

function build(
  action: AgentAction,
  cls: Reversibility,
  ruleRef: string,
  rationale: string,
  opRef: string,
  abstainedFrom?: Reversibility,
): Classification {
  return {
    actionId: action.id,
    class: cls,
    // Idempotency is orthogonal to the class: a present key (or a no-op) means the action — and
    // therefore its compensation — is safe to re-run. It never downgrades the class.
    idempotent: Boolean(action.idempotencyKey) || cls === "NULLIPOTENT",
    confidence: 1,
    llmAssisted: false,
    ruleRef: `${opRef}; ${ruleRef}`,
    rationale,
    ...(abstainedFrom ? { abstainedFrom } : {}),
  };
}

// ── the rule pipeline ──────────────────────────────────────────────────────────

/**
 * Deterministic classification. Returns `null` when the rules genuinely cannot
 * decide (the residual the LLM judge handles). `null` is honest abstention, not a
 * bug — the eval scores it as a miss, never as a wrong guess.
 */
export function classifyDeterministic(action: AgentAction): Classification | null {
  // 0. No durable effect → nothing to undo.
  if (action.committed === false) {
    return build(action, "NULLIPOTENT", "no-effect:uncommitted", "the call did not commit a durable change", "op:committed=false");
  }

  const { op, opRef } = resolveOp(action);
  const t = action.target;

  // 1. Destructive DDL is irreversible unless an open transaction can roll it back or an explicit
  //    backup exists (checked first; it would otherwise read as an ordinary `delete`).
  if (isDestructiveDdl(action)) {
    const sqlU = (str(param(action, "sql")) ?? str(param(action, "query")) ?? "").toUpperCase();
    // DROP DATABASE/TABLESPACE/SCHEMA can't run in a transaction block and is never recoverable.
    const neverRecoverable = /\bDROP\s+(DATABASE|TABLESPACE|SCHEMA)\b/.test(sqlU);
    if (inOpenTransaction(action) && !neverRecoverable) {
      return build(action, "REVERSIBLE", "sql:ddl-open-transaction-rollback", "TRUNCATE/DROP TABLE inside an open transaction; ROLLBACK restores the structure and its rows", opRef);
    }
    return t?.recoverable
      ? build(action, "COMPENSABLE", "sql:ddl-destructive-with-backup", "TRUNCATE/DROP, but a recoverable backup was recorded — restore from it", opRef)
      : build(action, "IRREVERSIBLE", "sql:ddl-destructive", "TRUNCATE/DROP with no recoverable copy destroys the structure and its rows", opRef, "COMPENSABLE");
  }

  switch (op) {
    case "read":
      return build(action, "NULLIPOTENT", "read:no-mutation", "a read observes state without changing it", opRef);

    case "create":
      if (t?.externalized) {
        return build(action, "COMPENSABLE", "create:externalized-copy", "the created artifact was handed to a party you don't control; deleting your copy does not retract theirs", opRef);
      }
      return build(action, "REVERSIBLE", "create:inverse-delete", "a created resource is removed by its inverse delete", opRef);

    case "append":
      return build(action, "COMPENSABLE", "append:correcting-entry", "an append cannot be un-appended; restore equivalent state with a correcting/reversing entry", opRef);

    case "update":
      if (t && t.priorState !== undefined) {
        return build(action, "REVERSIBLE", "update:prior-state-captured", "the prior value was captured; restore it to fully reverse the update", opRef);
      }
      if (t?.recoverable) {
        return build(action, "REVERSIBLE", "update:versioned-store", "the store keeps version history; roll the row back to the prior version", opRef);
      }
      // Prior value unknown and not recoverable: whether this can be compensated
      // depends on semantics the rules can't see. Abstain to the judge.
      return null;

    case "delete":
      if (t?.recoverable) {
        return build(action, "REVERSIBLE", "delete:recoverable-copy", "a recoverable copy exists (soft-delete / trash / backup / version history) — restore it", opRef);
      }
      if (inOpenTransaction(action)) {
        return build(action, "REVERSIBLE", "delete:open-transaction-rollback", "the delete is inside an open transaction; ROLLBACK restores the rows", opRef);
      }
      // Hard delete, no recoverable copy: fail toward severe.
      return build(action, "IRREVERSIBLE", "delete:no-recoverable-copy", "a hard delete with no recoverable copy cannot be restored", opRef, "REVERSIBLE");

    case "send":
      if (t && t.externalized === false) {
        return build(action, "REVERSIBLE", "send:internal-undelivered", "the message sits in an internal queue you control and was not delivered — remove it", opRef);
      }
      return build(action, "IRREVERSIBLE", "send:external-dispatch", "a message delivered to an external party cannot be un-sent; only a follow-up correction is possible", opRef, "COMPENSABLE");

    case "pay":
      // The deciding signal is settlement (did funds leave your control?). Commit only when it is
      // present; an unknown settlement state abstains to the judge rather than assume refundable.
      if (t?.externalized === true) {
        return build(action, "IRREVERSIBLE", "pay:funds-withdrawn", "the funds left your control (settled/withdrawn); a refund is no longer in your power", opRef, "COMPENSABLE");
      }
      if (t?.externalized === false) {
        return build(action, "COMPENSABLE", "pay:refundable-window", "the charge is within your control; a refund compensates it", opRef);
      }
      return null; // settlement state unknown → residual

    case "publish":
      // Reach is the deciding signal. Commit only when known; unknown reach abstains.
      if (t?.externalized === true) {
        return build(action, "IRREVERSIBLE", "publish:fanned-out", "the publish fanned out to recipients you don't control; a retraction cannot recall what was already delivered", opRef, "COMPENSABLE");
      }
      if (t?.externalized === false) {
        return build(action, "COMPENSABLE", "publish:retract-availability", "un-publishing restores availability; it does not undo that it was briefly visible", opRef);
      }
      return null; // reach unknown → residual

    case "deploy":
      return build(action, "COMPENSABLE", "deploy:rollback", "rolling back to the prior release compensates the change (data migrations it ran may need separate handling)", opRef);

    case "execute":
      // Arbitrary code: the effect is opaque to the rules. Residual.
      return null;

    case "custom":
      // Unrecognized tool, described only in free text. Residual.
      return null;
  }
}
