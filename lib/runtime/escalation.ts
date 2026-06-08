/**
 * Toffoli — escalation as a REAL, durable runtime path (not a return value).
 *
 * In a library, "escalate the irreversible remainder" can be a field on a result object. In an
 * unattended deployed service it cannot: if nobody is watching the return value, the actions that
 * matter MOST — the ones a human must decide — are silently dropped. So escalation here is a sink
 * an operator actually receives: a durable queue + one webhook, with a structured, timestamped
 * oversight record as auditable evidence. This is the EU AI Act Article 14 (human-oversight)
 * machinery, made operational.
 *
 * Two things escalate:
 *   - PLAN-TIME: the irreversible remainder + dominated compensations (no automation restores prior state).
 *   - RUNTIME:  COMPENSATION-FAILED — a compensation that was attempted and failed (the saga "zombie
 *               record" trap). Toffoli classifies reversibility at plan time; this is the runtime
 *               state for "we tried to undo and couldn't," and it must NEVER be a silent drop.
 *
 * Zero dependencies. The webhook delivery itself is the deploy step (a real fetch on Workers); here
 * we define the record, the sink interface, and in-memory + console sinks so the path is testable
 * and the storage/transport is swappable.
 */

import type { Clock } from "./journal";

export type EscalationKind =
  | "irreversible" // plan-time: no automatic action restores prior state
  | "dominated" // plan-time: a downstream irreversible action consumed this one's effect
  | "confirm-required" // RUNTIME: not auto-eligible under policy — a human must approve before it runs
  | "compensation-failed" // RUNTIME: a compensation was attempted and failed
  | "attestation-failed" // RUNTIME: the recovery context could not be verified — refused to restore
  | "judge-unavailable" // RUNTIME: the judge was down; action conservatively not auto-reversed
  | "blocked"; // RUNTIME: blocked by an earlier failed compensation (saga discipline)

export type EscalationSeverity = "low" | "medium" | "high" | "critical";

/** The structured oversight record. Designed to be both a Slack payload and an auditable log row. */
export interface OversightRecord {
  kind: EscalationKind;
  forActionId: string;
  /** The decision a human must make, in plain language. */
  decision: string;
  /** Why this reached a human (no automation could resolve it). */
  reason: string;
  severity: EscalationSeverity;
  /** The run this belongs to — for correlation and for the audit trail. */
  runId?: string;
  /** Who/what asked Toffoli to act (for the audit trail). */
  caller?: string;
  /** The compensation method involved, when there was one. */
  method?: string;
  /** ISO timestamp. */
  at: string;
  /** A link to the runbook the operator should follow — set into every alert payload. */
  runbookUrl?: string;
}

/** A place escalations durably go. The deploy wires this to a queue + one webhook. */
export interface EscalationSink {
  emit(record: OversightRecord): void | Promise<void>;
}

/** In-memory sink — for tests and as the durable-queue stand-in before deploy. */
export class InMemorySink implements EscalationSink {
  readonly records: OversightRecord[] = [];
  emit(record: OversightRecord): void {
    this.records.push(record);
  }
  bySeverity(s: EscalationSeverity): OversightRecord[] {
    return this.records.filter((r) => r.severity === s);
  }
  depth(): number {
    return this.records.length;
  }
}

/** Console sink — a visible default so an escalation is never invisible even with no transport wired. */
export class ConsoleSink implements EscalationSink {
  emit(record: OversightRecord): void {
    const tag = record.severity.toUpperCase();
    console.error(`  ⚠ ESCALATION [${tag}] ${record.kind} · action=${record.forActionId} · ${record.decision}`);
  }
}

/** Fan-out to several sinks (e.g. durable queue + console). A failing sink never blocks the others. */
export class MultiSink implements EscalationSink {
  constructor(private readonly sinks: EscalationSink[]) {}
  async emit(record: OversightRecord): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => Promise.resolve(s.emit(record))));
  }
}

export interface EscalatorOptions {
  runId?: string;
  caller?: string;
  runbookUrl?: string;
  clock?: Clock;
  /**
   * Invoked when the sink's delivery fails (a throw, or a rejected Promise from an async webhook).
   * The record is NEVER dropped: it is surfaced here so a transport failure is visible. Default
   * writes it to the console fallback. The deploy can route this to a durable backstop queue.
   */
  onDeliveryFailure?: (record: OversightRecord, err: unknown) => void;
}

/** Builds well-formed oversight records and emits them to the sink. Stamps run/caller/runbook. */
export class Escalator {
  private readonly clock: Clock;
  private readonly onDeliveryFailure: (record: OversightRecord, err: unknown) => void;
  constructor(private readonly sink: EscalationSink, private readonly opts: EscalatorOptions = {}) {
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.onDeliveryFailure =
      opts.onDeliveryFailure ??
      ((record, err) => {
        // NEVER a silent drop: a transport that fails still surfaces the record on the console fallback.
        console.error(`  ⚠ ESCALATION DELIVERY FAILED (${String(err)}) — record preserved [${record.severity}] ${record.kind} · action=${record.forActionId} · ${record.decision}`);
      });
  }

  emit(
    kind: EscalationKind,
    forActionId: string,
    decision: string,
    reason: string,
    severity: EscalationSeverity,
    method?: string,
  ): OversightRecord {
    const record: OversightRecord = {
      kind,
      forActionId,
      decision,
      reason,
      severity,
      method,
      runId: this.opts.runId,
      caller: this.opts.caller,
      runbookUrl: this.opts.runbookUrl,
      at: this.clock(),
    };
    // The returned record is ALWAYS captured by the caller (it lands in the RuntimeReport regardless),
    // so the record itself is never lost. Delivery to the sink is best-effort and failure-VISIBLE: a
    // throwing sink is caught, and a rejecting async sink (e.g. a webhook 503) is awaited via .catch so
    // it can never become an unhandledRejection that kills the process — both route to onDeliveryFailure.
    try {
      const maybe = this.sink.emit(record);
      if (maybe && typeof (maybe as Promise<void>).then === "function") {
        void (maybe as Promise<void>).catch((err) => this.onDeliveryFailure(record, err));
      }
    } catch (err) {
      this.onDeliveryFailure(record, err);
    }
    return record;
  }
}
