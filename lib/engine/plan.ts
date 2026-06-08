/**
 * Toffoli — the restitution planner (v1).
 *
 * Takes a run of actions and their classifications and produces a `RestitutionPlan`:
 * the compensating actions to run (in LIFO order — undo the newest effect first, the
 * saga-compensation rule), the irreversible remainder escalated to a human, and a
 * summary the receipt renders — including the PIVOT, the earliest irreversible action
 * (the point of no return; everything after it is retriable, not undoable).
 *
 * Each compensation declares its `restoration` guarantee — `exact` (the prior state is
 * restored bit-for-bit) vs `semantic` (an equal-and-opposite action; a refund is not an
 * un-charge). Toffoli PLANS the restitution; in v1 it does not execute it. Every
 * compensating action carries an idempotency guard so the plan is safe to re-run.
 *
 * Zero dependencies.
 */

import type {
  AgentAction,
  Classification,
  CompensatingAction,
  Escalation,
  Restoration,
  RestitutionPlan,
  RestitutionSummary,
  Severity,
} from "./types";

/** How to undo each REVERSIBLE/COMPENSABLE op, keyed off the rule that classified it. */
function compensationFor(action: AgentAction, c: Classification): CompensatingAction | null {
  const target = action.target;
  const forActionId = action.id;

  // NULLIPOTENT needs no compensation; IRREVERSIBLE is escalated, not compensated.
  if (c.class === "NULLIPOTENT" || c.class === "IRREVERSIBLE") return null;

  const make = (method: string, restoration: Restoration, rationale: string, extra?: Record<string, unknown>): CompensatingAction => ({
    forActionId,
    method,
    // A fresh, compensation-scoped key — NEVER the action's own key. Re-using the original
    // (e.g. a Stripe idempotency key) would make the refund dedupe to the charge and no-op.
    idempotencyKey: `restitution:${action.id}:${method}`,
    restoration,
    rationale,
    params: { ...ref(target), ...(extra ?? {}) },
  });

  const ruleHas = (frag: string) => c.ruleRef.includes(frag);

  if (ruleHas("create:inverse-delete")) return make("delete", "exact", "delete the resource the agent created");
  if (ruleHas("update:prior-state-captured")) return make("restore-prior", "exact", "write the captured prior value back", { to: target?.priorState });
  if (ruleHas("update:versioned-store")) return make("restore-version", "exact", "roll the row back to its prior version");
  if (ruleHas("delete:recoverable-copy")) return make("restore", "exact", "restore from the independent recoverable copy (backup / PITR / version history)");
  if (ruleHas("delete:open-transaction-rollback")) return make("rollback-transaction", "exact", "ROLLBACK the open transaction");
  if (ruleHas("send:internal-undelivered")) return make("dequeue", "exact", "remove the undelivered message from the internal queue");
  if (ruleHas("ddl-destructive-with-backup")) return make("restore-from-backup", "exact", "restore the dropped/truncated table from the recorded backup");
  if (ruleHas("append:correcting-entry")) return make("post-correcting-entry", "semantic", "append a reversing/correcting entry that nets the original to zero");
  if (ruleHas("pay:refundable-window")) return make("refund", "semantic", "issue a refund — the charge happened and stands; the refund offsets it", payExtra(action));
  if (ruleHas("publish:retract-availability")) return make("unpublish", "semantic", "un-publish to restore availability; it does not undo that it was briefly visible");
  if (ruleHas("deploy:rollback")) return make("rollback-release", "semantic", "roll back to the prior release (data migrations it ran may need separate handling)");
  if (ruleHas("create:externalized-copy")) return make("request-retraction", "semantic", "delete your copy and request the external holder retract theirs (best-effort)");

  // COMPENSABLE with no rule-specific inverse we recognize: a generic compensating entry.
  if (c.class === "COMPENSABLE") return make("compensate", "semantic", "apply a domain-specific compensating action to restore equivalent state");
  return null;
}

function ref(target: AgentAction["target"]): Record<string, unknown> {
  if (!target) return {};
  const out: Record<string, unknown> = { kind: target.kind };
  if (target.id !== undefined) out["id"] = target.id;
  return out;
}

function payExtra(action: AgentAction): Record<string, unknown> {
  const amt = action.params?.["amountUsd"];
  return typeof amt === "number" ? { amountUsd: amt } : {};
}

function escalationSeverity(c: Classification): Severity {
  if (c.ruleRef.includes("pay:funds-withdrawn")) return "critical";
  if (c.ruleRef.includes("delete:no-recoverable-copy") || c.ruleRef.includes("ddl-destructive")) return "critical";
  if (c.ruleRef.includes("send:external-dispatch")) return "high";
  if (c.ruleRef.includes("publish:fanned-out")) return "high";
  return "medium";
}

function decisionFor(c: Classification): string {
  if (c.ruleRef.includes("pay:funds-withdrawn")) return "Decide whether to pursue a claw-back or write off the lost funds.";
  if (c.ruleRef.includes("send:external-dispatch")) return "Decide whether to send a correction/retraction to the recipient.";
  if (c.ruleRef.includes("publish:fanned-out")) return "Decide whether to issue a public correction; the original reached its audience.";
  if (c.ruleRef.includes("delete:no-recoverable-copy") || c.ruleRef.includes("ddl-destructive")) return "Decide whether to rebuild the destroyed data from an external source; no independent copy remains.";
  if (c.ruleRef.includes("fail-safe-escalate")) return "Review this action by hand — the rules could not determine whether it can be undone.";
  return "Decide how to handle an effect that cannot be automatically reversed.";
}

function escalationFor(action: AgentAction, c: Classification): Escalation {
  return { forActionId: action.id, decision: decisionFor(c), reason: c.rationale, severity: escalationSeverity(c) };
}

/**
 * Build the plan. `actions` is the run (oldest → newest); `classifications` align by
 * `actionId`. Compensations come out in LIFO order (newest action undone first).
 */
export function plan(actions: AgentAction[], classifications: Classification[]): RestitutionPlan {
  const byId = new Map(classifications.map((c) => [c.actionId, c]));

  const compensations: CompensatingAction[] = [];
  const escalations: Escalation[] = [];
  const summary: RestitutionSummary = {
    total: actions.length,
    noEffect: 0,
    restored: 0,
    compensated: 0,
    irreversible: 0,
    fullyRecoverable: true,
    pivotActionId: pivot(actions, byId),
  };

  for (const action of orderForUndo(actions)) {
    const c = byId.get(action.id);
    if (!c) continue;
    switch (c.class) {
      case "NULLIPOTENT":
        summary.noEffect++;
        break;
      case "REVERSIBLE": {
        const comp = compensationFor(action, c);
        if (comp) compensations.push(comp);
        summary.restored++;
        break;
      }
      case "COMPENSABLE": {
        const comp = compensationFor(action, c);
        if (comp) compensations.push(comp);
        summary.compensated++;
        break;
      }
      case "IRREVERSIBLE":
        escalations.push(escalationFor(action, c));
        summary.irreversible++;
        summary.fullyRecoverable = false;
        break;
    }
  }

  return { classifications, compensations, escalations, summary };
}

/** The pivot: the EARLIEST (chronological) irreversible action — the point of no return. */
function pivot(actions: AgentAction[], byId: Map<string, Classification>): string | null {
  for (const action of orderChronological(actions)) {
    if (byId.get(action.id)?.class === "IRREVERSIBLE") return action.id;
  }
  return null;
}

function orderChronological(actions: AgentAction[]): AgentAction[] {
  const hasTimestamps = actions.every((a) => typeof a.at === "string");
  return hasTimestamps ? [...actions].sort((a, b) => (a.at as string).localeCompare(b.at as string)) : actions;
}

/** LIFO: undo the newest effect first. */
function orderForUndo(actions: AgentAction[]): AgentAction[] {
  const hasTimestamps = actions.every((a) => typeof a.at === "string");
  return hasTimestamps ? [...actions].sort((a, b) => (b.at as string).localeCompare(a.at as string)) : [...actions].reverse();
}
