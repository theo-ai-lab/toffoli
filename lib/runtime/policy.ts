/**
 * Toffoli — the auto-execution policy (the two-axis gate + default-deny allowlist).
 *
 * "Never auto-undo an irreversible action" is the floor. A deployed, unattended executor needs two
 * more guards on top of it:
 *
 *   1. A CONFIDENCE axis. Reversibility class is necessary but not sufficient — a HIGH-confidence
 *      wrong answer is the dangerous case. Gate auto-execution on BOTH the class AND the classifier's
 *      confidence. (Adapted from Prophet Security's two-axis remediation grid — note: Prophet's
 *      published axes are Blast-Radius × Detection-Confidence; re-mapping blast-radius onto Toffoli's
 *      reversibility class is OUR adaptation, not Prophet's labeling.)
 *
 *   2. A default-DENY action allowlist. Only explicitly-permitted compensation methods may execute
 *      automatically; everything else escalates. Scopes are per-target, not category-wide (Anthropic's
 *      containment report shows category/domain allowlists get abused).
 *
 * And a structural narrowing: the deterministic engine sets the CEILING on autonomy; an LLM-judge
 * verdict (`llmAssisted`) may only LOWER it. A judged verdict never earns auto-execution on its own —
 * the judge can demand escalation, never grant autonomy. This keeps the no-under-call property intact
 * under the judge.
 *
 * Zero dependencies.
 */

import type { Classification, CompensatingAction, Reversibility } from "../engine/types";

export interface AutoExecutePolicy {
  /** Reversibility classes eligible for AUTOMATIC compensation. Default: REVERSIBLE only. */
  allowClasses: Reversibility[];
  /** Minimum classifier confidence to auto-execute. Default 0.9. */
  minConfidence: number;
  /** Default-DENY allowlist of compensation methods that may auto-execute. Default: the exact inverses. */
  allowMethods: string[];
  /** May an LLM-judged (llmAssisted) verdict ever auto-execute? Default false — judge can only demand review. */
  allowLlmAssisted: boolean;
}

/**
 * The conservative default ("do no harm"): only EXACT, deterministic, high-confidence reversals run
 * automatically. A REFUND moves money and a correcting ledger entry are COMPENSABLE — those require an
 * explicit confirm token, never the unattended default. IRREVERSIBLE never auto-executes, by floor.
 */
export const DEFAULT_AUTO_POLICY: AutoExecutePolicy = {
  allowClasses: ["REVERSIBLE"],
  minConfidence: 0.9,
  allowMethods: ["delete", "restore"],
  allowLlmAssisted: false,
};

/** A permissive policy for the sandbox demo (so `npm run recover` still restores the COMPENSABLE refund). */
export const SANDBOX_AUTO_POLICY: AutoExecutePolicy = {
  allowClasses: ["REVERSIBLE", "COMPENSABLE"],
  minConfidence: 0.9,
  allowMethods: ["delete", "restore", "refund"],
  allowLlmAssisted: false,
};

export interface AutoDecision {
  auto: boolean;
  /** Why it may / may not auto-execute — recorded on the receipt and the audit log. */
  reason: string;
}

/**
 * Decide whether a single classified compensation may run AUTOMATICALLY (no human confirm). Every
 * "no" names the specific guard that blocked it. IRREVERSIBLE is rejected first and unconditionally.
 */
export function decideAuto(c: Classification, comp: CompensatingAction | undefined, policy: AutoExecutePolicy = DEFAULT_AUTO_POLICY): AutoDecision {
  if (c.class === "IRREVERSIBLE") return { auto: false, reason: "IRREVERSIBLE — escalate to a human (floor)" };
  if (c.class === "NULLIPOTENT") return { auto: false, reason: "NULLIPOTENT — nothing to undo" };
  if (!comp) return { auto: false, reason: "no compensation planned" };
  if (!(c.confidence >= 0 && c.confidence <= 1)) {
    // A non-finite or out-of-[0,1] confidence is a malformed verdict — never auto-execute on it.
    return { auto: false, reason: `invalid confidence ${c.confidence} (must be in [0,1]) — blocked` };
  }
  if (c.llmAssisted && !policy.allowLlmAssisted) {
    return { auto: false, reason: "judge-assisted verdict — confirm required (judge may lower autonomy, never grant it)" };
  }
  if (!policy.allowClasses.includes(c.class)) {
    return { auto: false, reason: `class ${c.class} not in auto-allow set [${policy.allowClasses.join(", ")}] — confirm required` };
  }
  if (c.confidence < policy.minConfidence) {
    return { auto: false, reason: `confidence ${c.confidence.toFixed(2)} < ${policy.minConfidence} — low-confidence, confirm required` };
  }
  if (!policy.allowMethods.includes(comp.method)) {
    return { auto: false, reason: `method '${comp.method}' not in default-deny allowlist [${policy.allowMethods.join(", ")}]` };
  }
  return { auto: true, reason: `auto-eligible: ${c.class} · confidence ${c.confidence.toFixed(2)} · method '${comp.method}'` };
}
