/**
 * Toffoli — the typed contract for the reversibility classifier + restitution planner.
 *
 * Single source of truth for the wire shape. The classifier (deterministic rules first,
 * the gated LLM judge only on the residual) takes an `AgentAction` and produces a
 * `Classification`. The planner turns a run of classified actions into a `RestitutionPlan`:
 * an ordered set of compensating actions plus the irreversible remainder, escalated to a
 * human.
 *
 * ── WHAT THE FOUR CLASSES ARE (and are not) ──
 * Reversibility is best modeled as a CONTINUOUS score Φ — the probability of returning to
 * the prior state within some horizon (Sorstkins et al., "Learning to Undo", arXiv:2510.14503).
 * Toffoli discretizes Φ into four operating buckets. This 4-bucket scheme is Toffoli's own
 * synthesis over verified prior art (Richardson's saga taxonomy; Garcia-Molina & Salem's
 * compensating-transaction definition, SIGMOD '87; the HTTP/idempotency canon). NO single
 * paper names all four together — see dataset/TAXONOMY.md. Do not present it as canonical.
 *
 * Crucially, IDEMPOTENCY (safe to re-execute) is ORTHOGONAL to reversibility: a payment-capture
 * POST carrying an idempotency key is idempotent AND irreversible. So idempotency is NOT a class
 * here — it is a separate signal (`Classification.idempotent`), used to make the *compensating*
 * action safe to retry, never to downgrade a class. The cost-free Φ≈1 bucket (the action changed
 * nothing) is NULLIPOTENT, not "idempotent".
 *
 * ── CITATION INVARIANT (house style) ──
 *   A `Classification` cannot exist without `ruleRef` (the rule/signal that produced it) and a
 *   one-line `rationale`. An uncited verdict is not representable.
 *
 * ── ASYMMETRIC-COST INVARIANT ──
 *   Calling an IRREVERSIBLE action recoverable is the catastrophic error — it promises an undo
 *   that, attempted, can destroy more state. Reversibility is a function of (action × external
 *   recovery state), NEVER the verb alone, and an UNKNOWN input biases TOWARD severe (escalate),
 *   never toward safe. This is the inverse of the documented RAC failure mode ("no compensation
 *   found → assume no side effects"). The headline metric is recall on the IRREVERSIBLE class.
 *
 * ── ADAPTER INVARIANT ──
 *   `AgentAction` is a generic, tool-agnostic record. An upstream accountability-ledger entry maps
 *   cleanly onto it (see lib/adapters/ledger.ts), but it carries NO dependency on any such ledger.
 */

// ── What the agent did (the adapter interface) ────────────────────────────────

export type ActionOp =
  | "read" // observed state; no mutation
  | "create" // added a resource (inverse: delete it)
  | "update" // mutated a resource (reversible iff the prior value is captured/recoverable)
  | "delete" // removed a resource (reversible iff an independent recoverable copy exists)
  | "append" // appended to a log/ledger/stream (no un-append; compensate with a correcting entry)
  | "send" // dispatched to an external party — email, SMS, webhook (no un-send)
  | "pay" // moved money (compensable via refund until settled/withdrawn, then irreversible)
  | "publish" // made something externally visible (retract restores availability, not the fact it was seen)
  | "deploy" // changed running infrastructure (rollback to the prior release)
  | "execute" // ran code / a shell command — effect unknown to the floor (residual → judge)
  | "custom"; // an unrecognized tool described only in free text (residual → judge)

/**
 * A handle to the thing an action touched.
 *
 * ── TRUST BOUNDARY (security) ──
 * `recoverable` and `externalized` are SAFE-direction signals — they let the floor commit to a
 * recoverable verdict. They MUST come from trusted runtime instrumentation that observed the real
 * system (a backup catalog, the payment processor, the mail server), NEVER copied from the agent's
 * own narration. If the action log is agent-authored and these can't be attested, OMIT them: the
 * floor then abstains or fails safe to IRREVERSIBLE rather than trust a self-report. (Cryptographic
 * attestation of recovery context is planned hardening — see SPEC.md.)
 */
export interface ResourceRef {
  /** e.g. "file" | "db.row" | "payment" | "email" | "deployment" | "blob". */
  kind: string;
  id?: string;
  /** The prior value/snapshot, if the runtime preserved one. Its presence makes an `update` REVERSIBLE. */
  priorState?: unknown;
  /**
   * True iff an INDEPENDENT recoverable copy exists: an off-host backup, point-in-time recovery,
   * version history, or a 30-day trash. A co-located backup deleted alongside the data does NOT
   * count (the PocketOS incident). Independence + retention + who-can-invoke is what makes a
   * `delete` REVERSIBLE rather than IRREVERSIBLE.
   */
  recoverable?: boolean;
  /**
   * True if the effect crossed a trust boundary to a party you don't control: an email reached a
   * recipient, a payment settled, a shipment dispatched. The single strongest IRREVERSIBLE signal.
   */
  externalized?: boolean;
}

export interface AgentAction {
  /** Stable id within a run. */
  id: string;
  /** The tool/function invoked, e.g. "http.request", "sql.execute", "email.send", "stripe.charge". */
  tool: string;
  /** The canonical operation, when the caller knows it. Inferred from `tool`/`params` when absent. */
  op?: ActionOp;
  /** Structured call parameters (method, url, sql, amountUsd, recipient, ...). */
  params?: Record<string, unknown>;
  /** The resource the action touched — the basis for planning compensation. */
  target?: ResourceRef;
  /** A Stripe-style idempotency key, if any. Makes the action de-duplicated (NOT reversible). */
  idempotencyKey?: string | null;
  /** Free-text effect description, used only when the structured fields are thin (what the judge reads). */
  effect?: string;
  /** ISO 8601 timestamp of the action. Drives the LIFO undo order and the pivot. */
  at?: string;
  /** Did the side effect actually commit? A dry-run / rolled-back call made no durable change. Defaults true. */
  committed?: boolean;
  /**
   * PASSIVE multi-agent correlation hook (single-trajectory by design). Persisting which agent and
   * run produced an action makes cross-agent correlation POSSIBLE later without standing up a
   * coordinator — Toffoli stays strictly single-trajectory; distributed cascading rollback is a
   * named research-scope limitation, not a feature. See docs/RELATED_WORK.md §3.
   */
  agentId?: string;
  runId?: string;
}

/** A run is just an ordered list of actions (oldest → newest). */
export type ActionLog = AgentAction[];

// ── The reversibility classes ─────────────────────────────────────────────────

/** The four buckets, in ascending severity. `moreSevere()` relies on this order. */
export type Reversibility =
  | "NULLIPOTENT" // the action changed nothing — a read, a no-op, an uncommitted call. Φ≈1 at zero cost.
  | "REVERSIBLE" // a direct inverse fully restores the EXACT prior state (delete a created row; restore a captured prior).
  | "COMPENSABLE" // no inverse, but a compensating action restores EQUIVALENT state (a refund is not an un-charge — the original stands).
  | "IRREVERSIBLE"; // no action restores prior state — only a human can decide (settled payment, sent email, destroyed-no-backup).

export const REVERSIBILITY_ORDER: readonly Reversibility[] = [
  "NULLIPOTENT",
  "REVERSIBLE",
  "COMPENSABLE",
  "IRREVERSIBLE",
] as const;

/** The more severe (less recoverable) of two classes. Ties return `a`. */
export function moreSevere(a: Reversibility, b: Reversibility): Reversibility {
  return REVERSIBILITY_ORDER.indexOf(a) >= REVERSIBILITY_ORDER.indexOf(b) ? a : b;
}

export type Severity = "low" | "medium" | "high" | "critical";

// ── The verdict for one action ────────────────────────────────────────────────

export interface Classification {
  actionId: string;
  /** The reversibility class. */
  class: Reversibility;
  /**
   * Idempotency — safe to re-execute — is ORTHOGONAL to the class. Tracked so the restitution
   * can be re-run safely; never used to downgrade `class`. (A keyed payment-capture is idempotent
   * yet IRREVERSIBLE.)
   */
  idempotent: boolean;
  /** 1.0 for deterministic rules (exact by construction); the judge reports its own. */
  confidence: number;
  /** True iff the LLM judge — not a deterministic rule — produced this. Badged in the UI. */
  llmAssisted: boolean;
  /** REQUIRED. The exact rule or signal that justifies the class (e.g. "RFC9110:safe-method", "delete:no-recoverable-copy"). */
  ruleRef: string;
  /** REQUIRED. One-line, human-legible reason. */
  rationale: string;
  /** When the floor escalated past an ambiguous boundary, the (less severe) class it abstained from. */
  abstainedFrom?: Reversibility;
}

// ── The restitution plan ──────────────────────────────────────────────────────

/** Whether a compensation restores the EXACT prior state, only EQUIVALENT state, or none is needed. */
export type Restoration = "exact" | "semantic" | "none";

/** A typed undo/compensate intent. Toffoli PLANS these; in v1 it does not execute them. */
export interface CompensatingAction {
  forActionId: string;
  /** The reversal to run, e.g. "fs.restore", "sql.delete", "stripe.refund", "http.delete". */
  method: string;
  params?: Record<string, unknown>;
  /** Idempotency guard so re-running the restitution is safe (derived from the action). */
  idempotencyKey: string;
  /** The guarantee this restitution provides — auditors care that a refund (semantic) is not an un-charge (exact). */
  restoration: Restoration;
  /** Why this restores (equivalent) state. */
  rationale: string;
}

/** The first-class irreversible remainder: what a human must decide, and why it can't be automated. */
export interface Escalation {
  forActionId: string;
  /** The decision a human must make, in plain language. */
  decision: string;
  /** Why no automatic action restores prior state. */
  reason: string;
  severity: Severity;
}

export interface RestitutionSummary {
  total: number;
  /** Actions that changed nothing (NULLIPOTENT) — no restitution needed. */
  noEffect: number;
  /** Actions with a direct exact inverse (REVERSIBLE). */
  restored: number;
  /** Actions handled by a semantic compensating action (COMPENSABLE). */
  compensated: number;
  /** Actions escalated to a human (IRREVERSIBLE). */
  irreversible: number;
  /** True iff nothing was left for a human — the world can be fully put back. */
  fullyRecoverable: boolean;
  /**
   * The PIVOT: the earliest irreversible action in the run — the point of no return. Everything
   * after it is "retriable, not undoable" (Richardson's saga taxonomy). Null when none is irreversible.
   */
  pivotActionId: string | null;
}

export interface RestitutionPlan {
  classifications: Classification[];
  /** Compensating actions in LIFO order (undo the newest effect first — the saga rule). */
  compensations: CompensatingAction[];
  /** The irreversible remainder. */
  escalations: Escalation[];
  summary: RestitutionSummary;
}

// ── A labeled ground-truth row (eval Sample / TDD fixture / demo datum) ─────────

export type Provenance =
  | "synthetic-seed" // hand-authored fixtures for engine dev — NEVER a reported prevalence number
  | "documented-incident" // real third-party failures (cited) — real, but a SEPARATE class
  | "self-run"; // real commissioned agent runs — the only PREVALENCE-eligible provenance

export interface GroundTruthSample {
  id: string;
  action: AgentAction;
  /** The human label: the reversibility class this action SHOULD be assigned. */
  target: { class: Reversibility };
  meta: {
    provenance: Provenance;
    notes?: string;
    /** Primary/reputable source URL for `documented-incident` rows. */
    source?: string;
  };
}

// ── The provenance firewall ───────────────────────────────────────────────────
//
// A metric that reports a PREVALENCE headline ("X% of agent actions are irreversible") MUST
// filter through these. The classifier-ACCURACY numbers (per-class P/R) may be reported on the
// full labeled set, clearly marked as accuracy-on-fixtures, never as a prevalence claim. Agent
// self-reported counts (e.g. an incident's confession) are never headline ground truth.

/** True iff this row is a real commissioned run (eligible for the prevalence headline). */
export function isHeadlineEligible(s: GroundTruthSample): boolean {
  return s.meta.provenance === "self-run";
}

/** True iff this row is real-world (your runs OR documented incidents) — i.e. not synthetic. */
export function isReal(s: GroundTruthSample): boolean {
  return s.meta.provenance !== "synthetic-seed";
}
