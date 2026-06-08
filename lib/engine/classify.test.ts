import { describe, it, expect } from "vitest";
import { classifyDeterministic } from "./classify";
import type { AgentAction } from "./types";

const A = (over: Partial<AgentAction>): AgentAction => ({ id: "t", tool: "x", ...over });

describe("classifyDeterministic — the deterministic floor", () => {
  it("reads and no-ops are NULLIPOTENT", () => {
    expect(classifyDeterministic(A({ tool: "http.request", params: { method: "GET" } }))?.class).toBe("NULLIPOTENT");
    expect(classifyDeterministic(A({ tool: "db.query", params: { sql: "SELECT 1" } }))?.class).toBe("NULLIPOTENT");
    expect(classifyDeterministic(A({ tool: "search_web" }))?.class).toBe("NULLIPOTENT");
  });

  it("an uncommitted call is NULLIPOTENT (no durable effect)", () => {
    expect(classifyDeterministic(A({ op: "delete", committed: false }))?.class).toBe("NULLIPOTENT");
  });

  it("create is REVERSIBLE; externalized create is COMPENSABLE", () => {
    expect(classifyDeterministic(A({ op: "create" }))?.class).toBe("REVERSIBLE");
    expect(classifyDeterministic(A({ op: "create", target: { kind: "doc", externalized: true } }))?.class).toBe("COMPENSABLE");
  });

  it("external send is IRREVERSIBLE; internal-undelivered send is REVERSIBLE", () => {
    expect(classifyDeterministic(A({ tool: "email.send", op: "send", target: { kind: "email", externalized: true } }))?.class).toBe("IRREVERSIBLE");
    expect(classifyDeterministic(A({ op: "send", target: { kind: "queue", externalized: false } }))?.class).toBe("REVERSIBLE");
  });

  it("DROP/TRUNCATE without backup is IRREVERSIBLE; with an independent backup, COMPENSABLE", () => {
    expect(classifyDeterministic(A({ tool: "db.execute", params: { sql: "DROP TABLE x" } }))?.class).toBe("IRREVERSIBLE");
    expect(classifyDeterministic(A({ tool: "db.execute", params: { sql: "TRUNCATE TABLE x" }, target: { kind: "table", recoverable: true } }))?.class).toBe("COMPENSABLE");
  });

  it("hard delete is IRREVERSIBLE; a recoverable-copy delete is REVERSIBLE", () => {
    expect(classifyDeterministic(A({ op: "delete", target: { kind: "blob", recoverable: false } }))?.class).toBe("IRREVERSIBLE");
    expect(classifyDeterministic(A({ op: "delete", target: { kind: "blob", recoverable: true } }))?.class).toBe("REVERSIBLE");
  });

  it("refundable pay is COMPENSABLE; withdrawn pay is IRREVERSIBLE", () => {
    expect(classifyDeterministic(A({ op: "pay", target: { kind: "payment", externalized: false } }))?.class).toBe("COMPENSABLE");
    expect(classifyDeterministic(A({ op: "pay", target: { kind: "payment", externalized: true } }))?.class).toBe("IRREVERSIBLE");
  });

  it("update with a captured prior is REVERSIBLE; without one, the floor abstains", () => {
    expect(classifyDeterministic(A({ op: "update", target: { kind: "row", priorState: { a: 1 } } }))?.class).toBe("REVERSIBLE");
    expect(classifyDeterministic(A({ op: "update", target: { kind: "row" } }))).toBeNull();
  });

  it("arbitrary execute and unrecognized custom tools abstain (the judge's residual)", () => {
    expect(classifyDeterministic(A({ op: "execute" }))).toBeNull();
    expect(classifyDeterministic(A({ tool: "partner.order_hook" }))).toBeNull();
  });

  it("fails toward severe: a hard delete records the class it abstained from", () => {
    const c = classifyDeterministic(A({ op: "delete", target: { kind: "x", recoverable: false } }));
    expect(c?.class).toBe("IRREVERSIBLE");
    expect(c?.abstainedFrom).toBe("REVERSIBLE");
  });

  it("idempotency is ORTHOGONAL: a keyed payment-capture is IRREVERSIBLE yet marked idempotent", () => {
    const c = classifyDeterministic(A({ op: "pay", idempotencyKey: "k1", target: { kind: "payment", externalized: true } }));
    expect(c?.class).toBe("IRREVERSIBLE");
    expect(c?.idempotent).toBe(true);
  });

  it("infers the op from the tool name when op is absent (twilio → send → IRREVERSIBLE)", () => {
    expect(classifyDeterministic(A({ tool: "twilio.sms" }))?.class).toBe("IRREVERSIBLE");
  });

  it("the citation invariant: every classification cites a rule and a rationale", () => {
    const c = classifyDeterministic(A({ op: "create" }));
    expect(c?.ruleRef.length ?? 0).toBeGreaterThan(0);
    expect(c?.rationale.length ?? 0).toBeGreaterThan(0);
  });
});

describe("classifyDeterministic — SQL & signal hardening (regression for review findings)", () => {
  it("a data-modifying CTE is a WRITE, never a NULLIPOTENT read", () => {
    const del = classifyDeterministic(A({ tool: "db.execute", params: { sql: "WITH d AS (DELETE FROM events RETURNING *) SELECT count(*) FROM d" } }));
    expect(del?.class).toBe("IRREVERSIBLE"); // DELETE with no recoverable copy
    const upd = classifyDeterministic(A({ tool: "db.execute", params: { sql: "WITH u AS (UPDATE accounts SET x=1 RETURNING *) SELECT 1" } }));
    expect(upd).toBeNull(); // UPDATE with no before-image → abstain, NOT a no-op read
  });

  it("a genuinely read-only CTE stays NULLIPOTENT", () => {
    expect(classifyDeterministic(A({ tool: "db.execute", params: { sql: "WITH t AS (SELECT 1) SELECT * FROM t" } }))?.class).toBe("NULLIPOTENT");
  });

  it("MERGE is treated as a write (abstains without a before-image), not a tool-name guess", () => {
    expect(classifyDeterministic(A({ tool: "db.execute", params: { sql: "MERGE INTO t USING s ON t.id=s.id WHEN MATCHED THEN UPDATE SET x=1" } }))).toBeNull();
  });

  it("destructive DDL inside an open transaction is REVERSIBLE (ROLLBACK); DROP DATABASE stays IRREVERSIBLE", () => {
    expect(classifyDeterministic(A({ tool: "db.execute", params: { sql: "TRUNCATE TABLE x", transaction: "open" } }))?.class).toBe("REVERSIBLE");
    expect(classifyDeterministic(A({ tool: "db.execute", params: { sql: "DROP TABLE x", transaction: "open" } }))?.class).toBe("REVERSIBLE");
    expect(classifyDeterministic(A({ tool: "db.execute", params: { sql: "DROP DATABASE prod", transaction: "open" } }))?.class).toBe("IRREVERSIBLE");
  });

  it("a multi-statement / BEGIN-wrapped DROP is still caught", () => {
    expect(classifyDeterministic(A({ tool: "db.execute", params: { sql: "BEGIN; DROP TABLE x;" } }))?.class).toBe("IRREVERSIBLE");
  });

  it("pay/publish ABSTAIN when the deciding signal (settlement / reach) is absent — no lenient under-call", () => {
    expect(classifyDeterministic(A({ op: "pay", params: { amountUsd: 100 } }))).toBeNull();
    expect(classifyDeterministic(A({ op: "publish" }))).toBeNull();
  });
});
