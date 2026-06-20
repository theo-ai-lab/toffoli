import { describe, it, expect } from "vitest";
import { authorize, PermissionOracle } from "./permission-oracle";
import { InMemoryJournal, type StepJournal, type IntentRecord, type JournalEntry } from "./journal";
import { InMemorySink } from "./escalation";
import { KILL_SWITCH_ENV } from "./mode";
import type { AgentAction, Classification } from "../engine/types";

const clock = () => "2026-06-14T00:00:00Z";
/** No kill-switch, default sandbox mode — the baseline environment for the per-class tests. */
const FREE: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv;
const A = (over: Partial<AgentAction>): AgentAction => ({ id: "a1", tool: "x", ...over });

// Representative actions, one per reversibility class (+ an abstaining one).
const READ = A({ id: "read", tool: "http.request", params: { method: "GET" } }); // NULLIPOTENT
const CREATE = A({ id: "create", op: "create" }); // REVERSIBLE
const APPEND = A({ id: "append", op: "append", target: { kind: "ledger" } }); // COMPENSABLE
const PAY_REFUND = A({ id: "pay-r", op: "pay", target: { kind: "payment", externalized: false } }); // COMPENSABLE
const SEND_EXT = A({ id: "send", tool: "email.send", op: "send", target: { kind: "email", externalized: true } }); // IRREVERSIBLE
const HARD_DELETE = A({ id: "del", op: "delete", target: { kind: "blob", recoverable: false } }); // IRREVERSIBLE
const UPDATE_UNKNOWN = A({ id: "upd", op: "update", target: { kind: "row" } }); // ABSTAIN (null)

describe("PermissionOracle — PROCEED / ESCALATE per reversibility class", () => {
  it("PROCEEDs on NULLIPOTENT / REVERSIBLE / COMPENSABLE — the floor can put it back", () => {
    for (const action of [READ, CREATE, APPEND, PAY_REFUND]) {
      const d = authorize(action, { env: FREE, clock });
      expect(d.verdict, `${action.id}`).toBe("PROCEED");
      expect(d.failClosed).toBe(false);
    }
    expect(authorize(READ, { env: FREE, clock }).class).toBe("NULLIPOTENT");
    expect(authorize(CREATE, { env: FREE, clock }).class).toBe("REVERSIBLE");
    expect(authorize(PAY_REFUND, { env: FREE, clock }).class).toBe("COMPENSABLE");
  });

  it("ESCALATEs on IRREVERSIBLE — only a human may authorize it (not a fail-closed fallback)", () => {
    for (const action of [SEND_EXT, HARD_DELETE]) {
      const d = authorize(action, { env: FREE, clock });
      expect(d.verdict, `${action.id}`).toBe("ESCALATE");
      expect(d.class).toBe("IRREVERSIBLE");
      expect(d.failClosed).toBe(false); // a confident irreversible verdict, not the abstention path
    }
  });

  it("a keyed (idempotent) settled payment still ESCALATEs — idempotency never grants autonomy", () => {
    const d = authorize(A({ id: "cap", op: "pay", idempotencyKey: "k1", target: { kind: "payment", externalized: true } }), { env: FREE, clock });
    expect(d.verdict).toBe("ESCALATE");
    expect(d.classification?.idempotent).toBe(true);
  });
});

describe("PermissionOracle — FAIL-CLOSED on abstention / uncertainty", () => {
  it("an abstaining action (update with no captured prior) ESCALATEs, marked fail-closed", () => {
    const d = authorize(UPDATE_UNKNOWN, { env: FREE, clock });
    expect(d.verdict).toBe("ESCALATE");
    expect(d.class).toBe("ABSTAIN");
    expect(d.classification).toBeNull();
    expect(d.failClosed).toBe(true);
    expect(d.reason).toMatch(/ABSTAINED/);
  });

  it("ANY injected abstention fails closed — uncertainty is never permission", () => {
    const alwaysAbstain = (): Classification | null => null;
    const d = authorize(CREATE, { env: FREE, clock, classify: alwaysAbstain });
    expect(d.verdict).toBe("ESCALATE");
    expect(d.failClosed).toBe(true);
  });

  it("execute / unrecognized custom tools (the judge's residual) fail closed to ESCALATE", () => {
    expect(authorize(A({ id: "x", op: "execute" }), { env: FREE, clock }).verdict).toBe("ESCALATE");
    expect(authorize(A({ id: "h", tool: "partner.order_hook" }), { env: FREE, clock }).verdict).toBe("ESCALATE");
  });
});

describe("PermissionOracle — kill-switch / mode chokepoint", () => {
  const KILLED: NodeJS.ProcessEnv = { [KILL_SWITCH_ENV]: "1" } as NodeJS.ProcessEnv;

  it("the kill-switch forces a would-be PROCEED (a MUTATING action) to ESCALATE", () => {
    const d = authorize(CREATE, { env: KILLED, clock });
    expect(d.verdict).toBe("ESCALATE");
    expect(d.killSwitchEngaged).toBe(true);
    expect(d.failClosed).toBe(true);
    expect(d.mode.effective).toBe("dry-run");
  });

  it("a COMPENSABLE refund is also forced to ESCALATE under the kill-switch", () => {
    expect(authorize(PAY_REFUND, { env: KILLED, clock }).verdict).toBe("ESCALATE");
  });

  it("a NULLIPOTENT read STILL proceeds under the kill-switch — it mutates nothing (mirrors mayMutate)", () => {
    const d = authorize(READ, { env: KILLED, clock });
    expect(d.verdict).toBe("PROCEED");
    expect(d.killSwitchEngaged).toBe(false);
  });

  it("dry-run mode (no kill-switch) also defers mutating actions to a human", () => {
    const d = authorize(CREATE, { mode: "dry-run", env: FREE, clock });
    expect(d.verdict).toBe("ESCALATE");
    expect(d.killSwitchEngaged).toBe(true);
    expect(d.reason).toMatch(/forbids world mutation/);
  });
});

describe("PermissionOracle — the WAL journal records every decision", () => {
  it("records one durable, confirmed entry per decision, carrying the verdict", () => {
    const oracle = new PermissionOracle({ env: FREE, clock });
    const actions = [READ, CREATE, SEND_EXT, UPDATE_UNKNOWN];
    const decisions = actions.map((a) => oracle.authorize(a));

    const entries = oracle.journal.entries();
    expect(entries.length).toBe(actions.length);
    for (const e of entries) {
      expect(e.status).toBe("done"); // an escalation is a COMPLETED decision, never a journal `fail`
      expect(e.method).toMatch(/^authorize:(proceed|escalate)$/);
      expect(oracle.journal.confirms(e.idemKey)).toBe(true);
    }
    // the journalled verdict matches the returned decision, in order
    for (let i = 0; i < decisions.length; i++) {
      expect(entries[i]!.method).toBe(`authorize:${decisions[i]!.verdict.toLowerCase()}`);
      expect(entries[i]!.detail).toContain(decisions[i]!.verdict);
    }
    expect(oracle.proceeded().map((d) => d.actionId)).toEqual(["read", "create"]);
    expect(oracle.escalated().map((d) => d.actionId)).toEqual(["send", "upd"]);
    expect(oracle.authorizationAudit().pass).toBe(true);
  });

  it("each decision gets a distinct journal row even for a repeated action id", () => {
    const oracle = new PermissionOracle({ env: FREE, clock });
    oracle.authorize(CREATE);
    oracle.authorize(CREATE);
    expect(oracle.journal.entries().length).toBe(2);
  });
});

describe("PermissionOracle — anti-fabrication: a PROCEED must be journal-confirmed", () => {
  /** A journal that records normally but can NEVER confirm — simulates a durable-write fault. */
  class LossyJournal implements StepJournal {
    private readonly inner = new InMemoryJournal(clock);
    intend(rec: IntentRecord): void {
      this.inner.intend(rec);
    }
    complete(idemKey: string, detail: string, attempts: number): void {
      this.inner.complete(idemKey, detail, attempts);
    }
    fail(idemKey: string, detail: string, attempts: number): void {
      this.inner.fail(idemKey, detail, attempts);
    }
    get(idemKey: string): JournalEntry | undefined {
      return this.inner.get(idemKey);
    }
    pending(): JournalEntry[] {
      return this.inner.pending();
    }
    entries(): JournalEntry[] {
      return this.inner.entries();
    }
    confirms(): boolean {
      return false; // the durable record can never be confirmed
    }
  }

  it("a would-be PROCEED whose authorization cannot be confirmed fails closed to ESCALATE", () => {
    const d = authorize(CREATE, { env: FREE, clock, journal: new LossyJournal() });
    expect(d.verdict).toBe("ESCALATE");
    expect(d.failClosed).toBe(true);
    expect(d.journalConfirmed).toBe(false);
    expect(d.reason).toMatch(/durably journaled/);
  });

  it("an IRREVERSIBLE ESCALATE is unaffected by a confirm fault — escalate is the safe direction", () => {
    const d = authorize(SEND_EXT, { env: FREE, clock, journal: new LossyJournal() });
    expect(d.verdict).toBe("ESCALATE");
  });
});

describe("PermissionOracle — escalations reach a durable oversight sink", () => {
  it("an ESCALATE emits one oversight record; a PROCEED emits none", () => {
    const sink = new InMemorySink();
    authorize(SEND_EXT, { env: FREE, clock, sink, runId: "run-1", caller: "agent" });
    authorize(CREATE, { env: FREE, clock, sink });
    expect(sink.depth()).toBe(1);
    const rec = sink.records[0]!;
    expect(rec.forActionId).toBe("send");
    expect(rec.kind).toBe("irreversible");
    expect(rec.runId).toBe("run-1");
  });

  it("an abstention escalation is delivered as a high-severity oversight record", () => {
    const sink = new InMemorySink();
    authorize(UPDATE_UNKNOWN, { env: FREE, clock, sink });
    expect(sink.depth()).toBe(1);
    expect(sink.records[0]!.severity).toBe("high");
  });
});

describe("PermissionOracle — determinism", () => {
  it("is a pure function of the action + environment", () => {
    const a = authorize(SEND_EXT, { env: FREE, clock });
    const b = authorize(SEND_EXT, { env: FREE, clock });
    expect(JSON.stringify({ ...a, mode: a.mode })).toBe(JSON.stringify({ ...b, mode: b.mode }));
  });
});
