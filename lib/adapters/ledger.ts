/**
 * Toffoli ← accountability-ledger adapter.
 *
 * An upstream accountability ledger (double-entry-style: what an agent was authorized to do vs. what
 * it actually did — charges, subscriptions, bookings) produces the verified record of an agent's
 * money actions. Toffoli consumes that record and plans the restitution: the ledger DETECTS the
 * discrepancy; Toffoli UNDOES it.
 *
 * Per the ADAPTER INVARIANT (lib/engine/types.ts): this carries NO dependency on any specific ledger
 * implementation. The interfaces below are a minimal *structural mirror* — a ledger entry satisfies
 * them by shape, so the two compose without being coupled. Point a real ledger's output at this
 * adapter and its rows become Toffoli `AgentAction`s.
 */

import type { AgentAction } from "../engine/types";

/** A ledger's `Authorization` row — what the user permitted. */
export interface LedgerAuthorization {
  budgetUsd?: number | null;
  scope?: string;
  mayPurchase?: boolean;
  mayRecur?: boolean;
}

/** A ledger's merchant-evidence row — what actually happened. */
export interface LedgerEvidence {
  merchant: string;
  amountUsd: number | null;
  date: string | null;
  items?: string[];
  recurring: boolean;
  recurringPeriod?: "weekly" | "monthly" | "annual";
  /** True once funds have settled/withdrawn (past the refund window). Drives externalization. */
  settled?: boolean;
}

/** One reconciled ledger row. */
export interface LedgerEntry {
  id: string;
  agent?: string;
  authorized?: LedgerAuthorization;
  evidence: LedgerEvidence;
}

/**
 * Map one ledger entry to a Toffoli action.
 *
 * A card charge the agent just made is modeled as `pay` that is NOT yet externalized (still within
 * your control via refund/dispute) → Toffoli classifies it COMPENSABLE and plans a refund. A
 * recurring subscription is the same, but the restitution also implies cancelling the recurrence —
 * surfaced in the effect text the receipt renders.
 */
export function ledgerEntryToAction(entry: LedgerEntry): AgentAction {
  const { evidence: e } = entry;
  const amount = e.amountUsd ?? undefined;
  const recurring = e.recurring === true;
  return {
    id: entry.id,
    tool: recurring ? "merchant.subscription" : "merchant.charge",
    op: "pay",
    params: amount !== undefined ? { amountUsd: amount } : {},
    target: {
      kind: recurring ? "subscription" : "payment",
      id: e.merchant,
      // Settlement is the deciding signal: a settled/withdrawn charge has left your control
      // (→ IRREVERSIBLE); a fresh, still-refundable one has not (→ COMPENSABLE).
      externalized: e.settled === true,
    },
    effect:
      (recurring ? "started a recurring charge" : "charged") +
      (amount != null ? ` $${amount}` : "") +
      ` at ${e.merchant}` +
      (recurring && e.recurringPeriod ? ` (${e.recurringPeriod})` : ""),
    ...(e.date ? { at: e.date } : {}),
  };
}

/** Map a whole ledger to a Toffoli action log. */
export function ledgerToActions(entries: LedgerEntry[]): AgentAction[] {
  return entries.map(ledgerEntryToAction);
}
