/**
 * Toffoli — the orchestrator.
 *
 * `classifyAction` applies the cascade: deterministic rules first; the gated judge on
 * the residual (marked `llmAssisted`); and, when the rules abstain with no judge
 * available, a fail-safe that escalates to IRREVERSIBLE rather than guess. `restitute`
 * classifies a whole run and hands it to the planner.
 *
 * The fail-safe encodes the asymmetric-cost invariant at the orchestration layer:
 * an unresolved action is treated as the thing you must NOT silently auto-undo.
 */

import { classifyDeterministic } from "./classify";
import { plan } from "./plan";
import type { ReversibilityJudge } from "./judge";
import type { AgentAction, Classification, RestitutionPlan } from "./types";

export interface RestituteOptions {
  /** When present, judges the residual the rules abstain on. Omit for deterministic-only. */
  judge?: ReversibilityJudge;
}

/** The fail-safe classification for an action no rule resolved and no judge handled. */
function failSafe(action: AgentAction, why: string): Classification {
  return {
    actionId: action.id,
    class: "IRREVERSIBLE",
    idempotent: Boolean(action.idempotencyKey),
    confidence: 0,
    llmAssisted: false,
    ruleRef: "abstain:fail-safe-escalate",
    rationale: `unresolved (${why}) — failing safe to IRREVERSIBLE so a human reviews it`,
  };
}

/** Classify one action through the full cascade. */
export async function classifyAction(action: AgentAction, judge?: ReversibilityJudge): Promise<Classification> {
  const deterministic = classifyDeterministic(action);
  if (deterministic) return deterministic;

  if (judge) {
    try {
      const v = await judge(action);
      return {
        actionId: action.id,
        class: v.class,
        idempotent: Boolean(action.idempotencyKey) || v.class === "NULLIPOTENT",
        confidence: v.confidence,
        llmAssisted: true,
        ruleRef: "llm-judge:residual",
        rationale: v.rationale,
      };
    } catch (err) {
      return failSafe(action, `judge error: ${(err as Error).message}`);
    }
  }
  return failSafe(action, "deterministic rules abstained; no judge configured");
}

/** Classify and plan restitution for a whole run. */
export async function restitute(actions: AgentAction[], opts: RestituteOptions = {}): Promise<RestitutionPlan> {
  const classifications = await Promise.all(actions.map((a) => classifyAction(a, opts.judge)));
  return plan(actions, classifications);
}
