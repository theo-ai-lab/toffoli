/**
 * Toffoli — the PERMISSION ORACLE: a reversibility-bounded PRE-ACT authorizer.
 *
 * This is the third leg of the "three-talk safety story". The mechanized Lean proof (sibling
 * worktree) is step 1: the no-under-call soundness theorem over the abstract classifier. The
 * counterexample search (lib/agent/counterexample-search.ts) is the empirical complement. THIS is
 * the runtime use the proof exists to license: a gate that replaces the human "are you sure you want
 * to do this?" permission prompt with a safety-floor-backed decision, made BEFORE the agent acts.
 *
 * The contract is exactly the proof's: classify the action with the deterministic floor
 * (lib/engine/classify.ts) and bind autonomy to reversibility.
 *
 *   PROCEED   — the floor proves the action is NULLIPOTENT, REVERSIBLE, or COMPENSABLE (Toffoli can
 *               undo or compensate it if it goes wrong). The agent may act unattended.
 *   ESCALATE  — the floor proves the action is IRREVERSIBLE. Only a human may authorize it.
 *   FAIL-CLOSED (escalate) — the floor ABSTAINED (it could not prove reversibility). Uncertainty is
 *               NOT permission. This is the asymmetric-cost invariant: an unknown biases toward the
 *               severe class, never toward "go ahead".
 *
 * Two more safety properties make it deployable, not just a pure function:
 *
 *  1. IT ROUTES THROUGH THE KILL-SWITCH CHOKEPOINT. Authorization consults `effectiveMode()`
 *     (lib/runtime/mode.ts) — the single place that decides whether the world may be mutated. When
 *     the floor forbids mutation (the kill-switch is engaged, or the effective mode is dry-run), a
 *     PROCEED that would MUTATE the world is forced to ESCALATE. The kill-switch is absolute here for
 *     the same reason it is in the safe executor: an unenforced freeze is worthless (the Replit
 *     incident). A pure NULLIPOTENT read still proceeds — it mutates nothing, so it cannot violate
 *     the freeze; this mirrors `mayMutate()` exactly, rather than inventing a stricter contract.
 *
 *  2. EVERY DECISION IS JOURNALED (WAL). The decision is recorded through the write-ahead journal
 *     (lib/runtime/journal.ts): intent BEFORE the authorization is issued, the resolved verdict
 *     AFTER. A PROCEED is HONOURED only if the journal `confirms()` it durably — if the durable
 *     record cannot be confirmed (a storage fault), the oracle fails closed to ESCALATE rather than
 *     authorize an act it cannot prove it recorded. This is the same anti-fabrication discipline the
 *     safe executor uses for "restored": authority you cannot prove you recorded is not authority.
 *     An ESCALATE is a first-class, durably-recorded decision — never a journal `fail` (invariant 4).
 *
 * Zero runtime dependencies (composes mode.ts, journal.ts, escalation.ts, and the engine classifier).
 */

import type { AgentAction, Classification, Reversibility } from "../engine/types";
import { classifyDeterministic } from "../engine/classify";
import { effectiveMode, mayMutate, type ExecutionMode, type ModeDecision } from "./mode";
import { InMemoryJournal, type Clock, type StepJournal } from "./journal";
import { Escalator, type EscalationSeverity, type EscalationSink, type OversightRecord } from "./escalation";

/** The two-valued authorization a pre-act gate returns. There is no third "maybe": uncertainty escalates. */
export type AuthorizationVerdict = "PROCEED" | "ESCALATE";

/** The class the action was assigned, or `"ABSTAIN"` when the deterministic floor could not decide. */
export type AuthorizationClass = Reversibility | "ABSTAIN";

export interface AuthorizationDecision {
  actionId: string;
  /** PROCEED (act unattended) or ESCALATE (a human must authorize). */
  verdict: AuthorizationVerdict;
  /** The reversibility class, or `"ABSTAIN"` when the floor abstained (→ fail-closed). */
  class: AuthorizationClass;
  /** The full deterministic classification, or `null` on an abstention. */
  classification: Classification | null;
  /** One-line, human-legible reason — recorded on the journal entry and any oversight record. */
  reason: string;
  /** The chokepoint decision (requested vs effective mode + kill-switch state). */
  mode: ModeDecision;
  /** True iff the kill-switch / dry-run floor forced a would-be PROCEED down to ESCALATE. */
  killSwitchEngaged: boolean;
  /**
   * True iff this ESCALATE is the SAFE-FACING fallback (the floor abstained, or a PROCEED could not be
   * durably journaled), as opposed to a confidently-IRREVERSIBLE escalation. The asymmetric-cost path.
   */
  failClosed: boolean;
  /** The write-ahead journal key this decision was recorded under. */
  idemKey: string;
  /** True iff the journal durably `confirms()` this decision — the basis on which a PROCEED is honoured. */
  journalConfirmed: boolean;
}

export interface AuthorizeOptions {
  /** Requested execution mode; the kill-switch can still force dry-run. Defaults from env (sandbox). */
  mode?: ExecutionMode;
  /** Injected env for deterministic kill-switch tests (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** The write-ahead journal the decision is recorded through. Defaults to a fresh in-memory journal. */
  journal?: StepJournal;
  /**
   * The reversibility classifier. Defaults to the deterministic floor (`classifyDeterministic`).
   * Injectable ONLY so tests can force a specific class / a forced abstention deterministically and so
   * the gated LLM judge can be slotted in behind it — never to bypass the deterministic floor.
   */
  classify?: (action: AgentAction) => Classification | null;
  /** Injected clock for deterministic journal/oversight timestamps. */
  clock?: Clock;
  /** A durable oversight sink an ESCALATE is delivered to (EU AI Act Art. 14 human oversight). Optional. */
  sink?: EscalationSink;
  /** Stable journal key override. Defaults to `authz:<actionId>`. */
  idemKey?: string;
  /** Correlation fields stamped onto any oversight record. */
  runId?: string;
  caller?: string;
  runbookUrl?: string;
}

/** Map a reversibility class to the escalation severity an operator sees. */
function severityFor(klass: AuthorizationClass, failClosed: boolean): EscalationSeverity {
  if (klass === "IRREVERSIBLE") return "high";
  if (failClosed) return "high"; // an abstention/uncertainty escalation is treated as high — it is the dangerous unknown
  return "medium";
}

/** True iff acting on this class would MUTATE the world (everything except a NULLIPOTENT read). */
function wouldMutate(klass: AuthorizationClass): boolean {
  return klass !== "NULLIPOTENT";
}

/**
 * Authorize a single agent action BEFORE it runs. Pure given its options (the only impurity is the
 * journal write + optional sink delivery the caller supplies). See the module header for the contract.
 */
export function authorize(action: AgentAction, opts: AuthorizeOptions = {}): AuthorizationDecision {
  const mode = effectiveMode(opts.mode, opts.env ?? process.env);
  const classify = opts.classify ?? classifyDeterministic;
  const journal = opts.journal ?? new InMemoryJournal(opts.clock);
  const idemKey = opts.idemKey ?? `authz:${action.id}`;

  const classification = classify(action);
  const klass: AuthorizationClass = classification ? classification.class : "ABSTAIN";

  // ── 1. base verdict from the reversibility floor ──
  let verdict: AuthorizationVerdict;
  let failClosed = false;
  let reason: string;
  if (classification === null) {
    // The floor could not prove reversibility. Uncertainty is not permission — fail closed.
    verdict = "ESCALATE";
    failClosed = true;
    reason = "the deterministic floor ABSTAINED (it cannot prove this action is reversible) — fail-closed to human authorization";
  } else if (classification.class === "IRREVERSIBLE") {
    verdict = "ESCALATE";
    reason = `IRREVERSIBLE — only a human may authorize this (${classification.ruleRef})`;
  } else {
    verdict = "PROCEED";
    reason = `${classification.class} — within the reversibility floor; safe to act unattended (${classification.ruleRef})`;
  }

  // ── 2. route through the kill-switch / mode chokepoint ──
  // The floor may only make the verdict MORE conservative, never less. A would-be PROCEED on a
  // MUTATING action is forced to ESCALATE when the effective mode forbids mutation (kill-switch
  // engaged, or dry-run). A nullipotent read mutates nothing, so the freeze does not bind it.
  let killSwitchForced = false;
  if (verdict === "PROCEED" && wouldMutate(klass) && !mayMutate(mode.effective)) {
    verdict = "ESCALATE";
    killSwitchForced = true;
    failClosed = true; // a freeze-forced escalation is a safe-facing deferral, not a confident verdict
    reason = mode.killSwitchEngaged
      ? `${mode.reason} — a mutating action cannot be authorized under the kill-switch; deferred to a human`
      : `effective mode '${mode.effective}' forbids world mutation — a mutating action is deferred to a human`;
  }

  // ── 3. write-ahead journal the decision ──
  // Intent BEFORE the authorization is issued; the resolved verdict AFTER. Both PROCEED and ESCALATE
  // are recorded as COMPLETED decisions (an escalation is a first-class output, never a journal fail).
  const method = `authorize:${verdict.toLowerCase()}`;
  journal.intend({ idemKey, forActionId: action.id, method });
  journal.complete(idemKey, `${verdict}: ${reason}`, 1);
  let journalConfirmed = journal.confirms(idemKey);

  // ── 4. anti-fabrication: a PROCEED is honoured ONLY if the journal durably confirms it ──
  // If the durable record cannot be confirmed (a storage fault), refuse to authorize an act we cannot
  // prove we recorded. The unsafe direction (PROCEED) is gated on confirmation; ESCALATE never is.
  if (verdict === "PROCEED" && !journalConfirmed) {
    verdict = "ESCALATE";
    failClosed = true;
    reason = "the PROCEED authorization could not be durably journaled — fail-closed; refusing to act on an unrecorded grant";
    // Re-record the corrected verdict best-effort (in a healthy journal this branch never fires).
    journal.complete(idemKey, `${verdict}: ${reason}`, 2);
    journalConfirmed = journal.confirms(idemKey);
  }

  const decision: AuthorizationDecision = {
    actionId: action.id,
    verdict,
    class: klass,
    classification,
    reason,
    mode,
    killSwitchEngaged: killSwitchForced,
    failClosed,
    idemKey,
    journalConfirmed,
  };

  // ── 5. deliver an ESCALATE to the durable oversight sink, if one is wired ──
  if (verdict === "ESCALATE" && opts.sink) {
    const escalator = new Escalator(opts.sink, {
      runId: opts.runId,
      caller: opts.caller,
      runbookUrl: opts.runbookUrl,
      clock: opts.clock,
    });
    const kind = failClosed ? (mode.killSwitchEngaged || killSwitchForced ? "blocked" : "judge-unavailable") : "irreversible";
    escalator.emit(
      kind,
      action.id,
      `A human must authorize this action before it runs (${action.tool}).`,
      reason,
      severityFor(klass, failClosed),
      action.op,
    );
  }

  return decision;
}

export interface PermissionOracleOptions {
  mode?: ExecutionMode;
  env?: NodeJS.ProcessEnv;
  /** A persistent journal so the oracle records EVERY decision it makes. Defaults to in-memory. */
  journal?: StepJournal;
  classify?: (action: AgentAction) => Classification | null;
  clock?: Clock;
  sink?: EscalationSink;
  runId?: string;
  caller?: string;
  runbookUrl?: string;
}

/**
 * The deployable surface: a stateful gate that holds one journal (and optional oversight sink) and
 * records every authorization it makes. Wrap a tool-calling loop's "may I run this action?" check in
 * `oracle.authorize(action)` and act only on a PROCEED.
 */
export class PermissionOracle {
  /** The write-ahead journal every decision is recorded through — the durable audit trail. */
  readonly journal: StepJournal;
  private readonly log: AuthorizationDecision[] = [];
  private seq = 0;

  constructor(private readonly opts: PermissionOracleOptions = {}) {
    this.journal = opts.journal ?? new InMemoryJournal(opts.clock);
  }

  /** Authorize one action. Records the decision in the journal and the in-memory decision log. */
  authorize(action: AgentAction): AuthorizationDecision {
    // A per-oracle counter keys each decision distinctly, so a repeated action id still records a
    // SEPARATE journal row (the audit trail is one row per decision, not one per action id).
    const idemKey = `authz:${action.id}#${this.seq++}`;
    const decision = authorize(action, { ...this.opts, journal: this.journal, idemKey });
    this.log.push(decision);
    return decision;
  }

  /** Every decision the oracle has made, in order. */
  decisions(): AuthorizationDecision[] {
    return [...this.log];
  }
  /** The decisions that authorized the agent to act. */
  proceeded(): AuthorizationDecision[] {
    return this.log.filter((d) => d.verdict === "PROCEED");
  }
  /** The decisions that were deferred to a human. */
  escalated(): AuthorizationDecision[] {
    return this.log.filter((d) => d.verdict === "ESCALATE");
  }

  /**
   * The deployment anti-fabrication audit: every PROCEED the oracle issued must be journal-confirmed.
   * `pass:false` means the gate authorized an act whose authorization it could not prove it recorded.
   */
  authorizationAudit(): { pass: boolean; detail: string } {
    const unconfirmed = this.proceeded().filter((d) => !d.journalConfirmed);
    return {
      pass: unconfirmed.length === 0,
      detail:
        unconfirmed.length === 0
          ? "every PROCEED is journal-confirmed"
          : `${unconfirmed.length} PROCEED(s) NOT journal-confirmed: ${unconfirmed.map((d) => d.actionId).join(", ")}`,
    };
  }
}

/** Re-export for callers that build oversight records off an oracle escalation. */
export type { OversightRecord };
