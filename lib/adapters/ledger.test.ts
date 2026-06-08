import { describe, it, expect } from "vitest";
import { ledgerToActions, type LedgerEntry } from "./ledger";
import { classifyDeterministic } from "../engine/classify";
import { plan } from "../engine/plan";

describe("accountability-ledger adapter", () => {
  const ledger: LedgerEntry[] = [
    { id: "p1", evidence: { merchant: "Acme", amountUsd: 20, date: "2026-06-01", recurring: false } },
    { id: "p2", evidence: { merchant: "Sub", amountUsd: 9, date: "2026-06-01", recurring: true, recurringPeriod: "monthly" } },
    { id: "p3", evidence: { merchant: "Payout", amountUsd: 500, date: "2026-06-01", recurring: false, settled: true } },
  ];
  const actions = ledgerToActions(ledger);

  it("maps each ledger row to a pay action (no coupling to the ledger implementation)", () => {
    expect(actions).toHaveLength(3);
    expect(actions.every((a) => a.op === "pay")).toBe(true);
  });

  it("a fresh charge is COMPENSABLE (refundable); a settled payout is IRREVERSIBLE", () => {
    expect(classifyDeterministic(actions[0]!)?.class).toBe("COMPENSABLE");
    expect(classifyDeterministic(actions[2]!)?.class).toBe("IRREVERSIBLE");
  });

  it("the plan refunds the recoverable charges and escalates the settled one", () => {
    const classifications = actions.map((a) => classifyDeterministic(a)!);
    const p = plan(actions, classifications);
    expect(p.compensations.some((c) => c.method === "refund")).toBe(true);
    expect(p.summary.irreversible).toBe(1);
  });
});
