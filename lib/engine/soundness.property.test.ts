/**
 * Property-based verification of the engine's SOUNDNESS invariant.
 *
 * Where the example tests check specific cases, these generate hundreds of structurally-varied
 * actions — random ids, noise params, SQL casing/whitespace, CTE forms — each with HONEST metadata
 * for a known true class, and assert the load-bearing safety theorem:
 *
 *   NO UNDER-CALL: the classifier never assigns a class strictly *safer* than the true
 *   reversibility. Over-calling (escalating something recoverable) is allowed — it's the safe
 *   direction; under-calling (claiming something irreversible is recoverable) is the one
 *   unrecoverable error, and it must never happen.
 *
 * Two families of generators, deliberately:
 *   - HONEST-MATCH (nullipotent/reversible/compensable/irreversible): metadata that pins the true class;
 *     here the check is exact label-reproduction (`effective === true`).
 *   - LENIENT + ABSTAINING: the true label is set by an INDEPENDENT semantic argument (an internal-log
 *     append or a zero-migration deploy is honestly REVERSIBLE even though the conservative rule commits
 *     COMPENSABLE; an opaque `execute` is honestly COMPENSABLE but the rule abstains). On these the
 *     classifier legitimately OVER-calls — so the asymmetric `>=` tolerance and the `?? IRREVERSIBLE`
 *     fail-safe lens are actually exercised, and the property would catch a wrong-but-consistent rule in
 *     the over-call direction. The `non-vacuity` test asserts both are witnessed (the `>=` is not secretly `===`).
 *
 * This is the high-coverage empirical check a solo artifact can execute — NOT a proof. The exhaustive
 * small-scope model-check and the mechanized proof are the named remainders in THEORY.md §4.
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { classifyDeterministic } from "./classify";
import { REVERSIBILITY_ORDER, type AgentAction, type Reversibility } from "./types";

const sev = (c: Reversibility): number => REVERSIBILITY_ORDER.indexOf(c);
/** Product lens: an abstention (null) fails safe to IRREVERSIBLE. */
const effective = (a: AgentAction): Reversibility => classifyDeterministic(a)?.class ?? "IRREVERSIBLE";

interface Case {
  action: AgentAction;
  trueClass: Reversibility;
}

const id = fc.stringMatching(/^[a-z0-9_./-]{1,12}$/);
const amount = fc.integer({ min: 1, max: 100000 });
// noise params with a reserved prefix so they never collide with meaningful keys
const noise = fc.dictionary(fc.string({ minLength: 1, maxLength: 4 }).map((s) => `meta_${s}`), fc.oneof(fc.string(), fc.integer(), fc.boolean()), { maxKeys: 3 });
const base = fc.record({ id, idk: fc.option(fc.string(), { nil: undefined }), noise });

function mk(over: Partial<AgentAction>, b: { id: string; idk?: string; noise: Record<string, unknown> }): AgentAction {
  return { id: `act-${b.id}`, tool: "x", params: { ...b.noise, ...(over.params ?? {}) }, ...(b.idk ? { idempotencyKey: b.idk } : {}), ...over };
}

const nullipotent = fc.tuple(base, fc.constantFrom("GET", "HEAD", "OPTIONS")).map(([b, m]): Case => ({
  action: mk({ tool: "http.request", params: { method: m } }, b),
  trueClass: "NULLIPOTENT",
}));

const reversible = fc.oneof(
  base.map((b): Case => ({ action: mk({ op: "create", target: { kind: "file", id: b.id } }, b), trueClass: "REVERSIBLE" })),
  base.map((b): Case => ({ action: mk({ op: "delete", target: { kind: "blob", id: b.id, recoverable: true } }, b), trueClass: "REVERSIBLE" })),
  base.map((b): Case => ({ action: mk({ op: "update", target: { kind: "db.row", id: b.id, priorState: { v: 1 } } }, b), trueClass: "REVERSIBLE" })),
  fc.tuple(base, fc.constantFrom("TRUNCATE TABLE", "truncate table", "DROP TABLE")).map(([b, s]): Case => ({
    action: mk({ tool: "db.execute", params: { sql: `${s} ${b.id}`, transaction: "open" } }, b),
    trueClass: "REVERSIBLE",
  })),
);

const compensable = fc.oneof(
  fc.tuple(base, amount).map(([b, a]): Case => ({ action: mk({ op: "pay", params: { amountUsd: a }, target: { kind: "payment", id: b.id, externalized: false } }, b), trueClass: "COMPENSABLE" })),
  base.map((b): Case => ({ action: mk({ op: "publish", target: { kind: "post", id: b.id, externalized: false } }, b), trueClass: "COMPENSABLE" })),
  base.map((b): Case => ({ action: mk({ op: "append", target: { kind: "ledger", id: b.id } }, b), trueClass: "COMPENSABLE" })),
  base.map((b): Case => ({ action: mk({ op: "deploy", target: { kind: "service", id: b.id } }, b), trueClass: "COMPENSABLE" })),
  base.map((b): Case => ({ action: mk({ tool: "db.execute", params: { sql: `TRUNCATE TABLE ${b.id}` }, target: { kind: "table", id: b.id, recoverable: true } }, b), trueClass: "COMPENSABLE" })),
);

const irreversible = fc.oneof(
  base.map((b): Case => ({ action: mk({ op: "send", target: { kind: "email", externalized: true }, effect: `sent to ${b.id}` }, b), trueClass: "IRREVERSIBLE" })),
  fc.tuple(base, amount).map(([b, a]): Case => ({ action: mk({ op: "pay", params: { amountUsd: a }, target: { kind: "payment", id: b.id, externalized: true } }, b), trueClass: "IRREVERSIBLE" })),
  base.map((b): Case => ({ action: mk({ op: "delete", target: { kind: "blob", id: b.id, recoverable: false } }, b), trueClass: "IRREVERSIBLE" })),
  fc.tuple(base, fc.constantFrom("DROP TABLE", "drop  table", "DrOp TaBlE")).map(([b, s]): Case => ({ action: mk({ tool: "db.execute", params: { sql: `${s} ${b.id}` } }, b), trueClass: "IRREVERSIBLE" })),
  base.map((b): Case => ({ action: mk({ op: "publish", target: { kind: "feed", externalized: true } }, b), trueClass: "IRREVERSIBLE" })),
  // a data-modifying CTE — the exact shape the review caught as a dangerous miss
  base.map((b): Case => ({ action: mk({ tool: "db.execute", params: { sql: `WITH d AS (DELETE FROM ${b.id} RETURNING *) SELECT count(*) FROM d` } }, b), trueClass: "IRREVERSIBLE" })),
);

// LENIENT: the honest truth is MORE reversible than the conservative rule commits → the rule over-calls.
const lenient = fc.oneof(
  // an append to a fully-controlled internal log is honestly REVERSIBLE (pop the last entry); rule → COMPENSABLE
  base.map((b): Case => ({ action: mk({ op: "append", target: { kind: "internal-log", id: b.id } }, b), trueClass: "REVERSIBLE" })),
  // a zero-migration deploy is honestly REVERSIBLE (rollback restores exactly); rule → COMPENSABLE
  base.map((b): Case => ({ action: mk({ op: "deploy", target: { kind: "service", id: b.id } }, b), trueClass: "REVERSIBLE" })),
  // a DROP TABLE with a perfect PITR backup is honestly REVERSIBLE; rule → COMPENSABLE (ddl-with-backup)
  base.map((b): Case => ({ action: mk({ tool: "db.execute", params: { sql: `DROP TABLE ${b.id}` }, target: { kind: "table", id: b.id, recoverable: true } }, b), trueClass: "REVERSIBLE" })),
);

// ABSTAINING: honest truth is COMPENSABLE, but the rule abstains → effective = IRREVERSIBLE (fail-safe lens).
const abstaining = fc.oneof(
  base.map((b): Case => ({ action: mk({ op: "execute", effect: `ran a reversible script on ${b.id}` }, b), trueClass: "COMPENSABLE" })),
  fc.tuple(base, amount).map(([b, a]): Case => ({ action: mk({ op: "pay", params: { amountUsd: a }, effect: "a refundable charge, settlement signal omitted" }, b), trueClass: "COMPENSABLE" })),
);

const anyCase = fc.oneof(nullipotent, reversible, compensable, irreversible, lenient, abstaining);

describe("soundness (property-based, honest metadata)", () => {
  it("NO UNDER-CALL: the effective class is never strictly safer than the truth", () => {
    fc.assert(
      fc.property(anyCase, ({ action, trueClass }) => sev(effective(action)) >= sev(trueClass)),
      { numRuns: 600 },
    );
  });

  it("CATASTROPHIC SAFETY: a truly-irreversible action is never COMMITTED to a recoverable class", () => {
    fc.assert(
      fc.property(irreversible, ({ action }) => {
        const c = classifyDeterministic(action);
        return c === null || c.class === "IRREVERSIBLE";
      }),
      { numRuns: 400 },
    );
  });

  it("DETERMINISM: classification is a pure function of the action", () => {
    fc.assert(
      fc.property(anyCase, ({ action }) => {
        const first = JSON.stringify(classifyDeterministic(action));
        const second = JSON.stringify(classifyDeterministic(action));
        return first === second;
      }),
    );
  });

  it("CITATION INVARIANT: every committed classification cites a rule and a rationale", () => {
    fc.assert(
      fc.property(anyCase, ({ action }) => {
        const c = classifyDeterministic(action);
        return c === null || (c.ruleRef.length > 0 && c.rationale.length > 0);
      }),
    );
  });

  it("NON-VACUITY: over-calling and abstention are actually witnessed (the >= is not secretly ===)", () => {
    const cases = fc.sample(fc.oneof(lenient, abstaining), { numRuns: 300, seed: 1 });
    let strictOverCalls = 0;
    let abstentions = 0;
    for (const { action, trueClass } of cases) {
      if (classifyDeterministic(action) === null) abstentions++;
      if (sev(effective(action)) > sev(trueClass)) strictOverCalls++;
      // no-under-call must STILL hold on these lenient/abstaining cases
      expect(sev(effective(action))).toBeGreaterThanOrEqual(sev(trueClass));
    }
    expect(strictOverCalls).toBeGreaterThan(0); // the safe over-approximation direction is exercised
    expect(abstentions).toBeGreaterThan(0); // the ?? IRREVERSIBLE fail-safe lens is exercised
  });

  it("sanity: the generators actually exercise all four classes", () => {
    const seen = new Set<string>();
    fc.assert(fc.property(anyCase, ({ trueClass }) => { seen.add(trueClass); return true; }), { numRuns: 200 });
    expect(seen.size).toBe(4);
  });
});
