/**
 * Toffoli — recovery telemetry as OpenTelemetry-shaped spans.
 *
 * Production recovery systems need to be *observable* — a team should see "Toffoli classified 6
 * actions, restored 4, escalated 2" in their existing tool. This module turns a recovery run into
 * spans in the OpenTelemetry data model (an OTLP-compatible JSON shape), with the standard
 * `gen_ai.*` attributes where they exist plus namespaced `toffoli.*` custom attributes for the
 * recovery-specific facts (there is no rollback/undo attribute in the OTel GenAI semantic
 * conventions yet — these are honest CUSTOM attributes, not a claimed standard).
 *
 * Because the output is OTLP-shaped, it drops into any OpenTelemetry-based backend; the
 * `consoleExporter` and `fileExporter` here run with zero setup, and `docs/OBSERVABILITY.md`
 * documents pointing the same spans at LangSmith or AgentOps. Zero dependencies.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ResumablePlan } from "../engine/resumable";
import type { RecoveryResult } from "../exec/executor";

export type AttrValue = string | number | boolean;

export interface Span {
  name: string;
  /** "internal" — these model work inside the recovery loop. */
  kind: "internal";
  traceId: string; // 16-byte hex
  spanId: string; // 8-byte hex
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, AttrValue>;
  status: { code: "OK" | "ERROR"; message?: string };
}

export type SpanExporter = (spans: Span[]) => void;

const hex = (n: number): string => randomBytes(n).toString("hex");

/** Fraction of recoverable damage actually reversed by the executor (1.0 = fully recovered). */
export function recoveryConfidence(result: RecoveryResult, recoverable: number): number {
  return recoverable > 0 ? Number((result.restored / recoverable).toFixed(3)) : 1;
}

/**
 * Turn a recovery run into OTLP-shaped spans: a root `toffoli.recover` span, a child
 * `toffoli.classify` span per action, and a child `toffoli.compensate` span per executed step.
 * `clockNs` lets callers inject a deterministic clock (defaults to a fixed base for reproducibility).
 */
export function recordRecovery(
  plan: ResumablePlan,
  result: RecoveryResult,
  opts: { recoverable: number; irreversible: number; clockNs?: () => string } = { recoverable: 0, irreversible: 0 },
): Span[] {
  const traceId = hex(16);
  const rootId = hex(8);
  let t = 1_780_000_000_000_000_000n; // fixed base epoch (ns) — deterministic unless a clock is injected
  const tick =
    opts.clockNs ??
    (() => {
      t += 1_000_000n;
      return t.toString();
    });

  const conf = recoveryConfidence(result, opts.recoverable);
  const spans: Span[] = [];

  const rootStart = tick();
  // classifications
  for (const c of plan.base.classifications) {
    const s = tick();
    const e = tick();
    spans.push({
      name: "toffoli.classify",
      kind: "internal",
      traceId,
      spanId: hex(8),
      parentSpanId: rootId,
      startTimeUnixNano: s,
      endTimeUnixNano: e,
      attributes: {
        "gen_ai.operation.name": "classify",
        "toffoli.action.id": c.actionId,
        "toffoli.classification": c.class,
        "toffoli.llm_assisted": c.llmAssisted,
        "toffoli.confidence": c.confidence,
        "toffoli.rule_ref": c.ruleRef,
      },
      status: { code: "OK" },
    });
  }
  // compensations: the planned step (method + restoration guarantee) joined with the executor's status
  const statusByAction = new Map(result.steps.map((r) => [r.forActionId, r]));
  for (const step of plan.steps) {
    const r = statusByAction.get(step.forActionId);
    const status = r?.status ?? "planned";
    const s = tick();
    const e = tick();
    spans.push({
      name: "toffoli.compensate",
      kind: "internal",
      traceId,
      spanId: hex(8),
      parentSpanId: rootId,
      startTimeUnixNano: s,
      endTimeUnixNano: e,
      attributes: {
        "gen_ai.operation.name": "compensate",
        "toffoli.action.id": step.forActionId,
        "toffoli.restitution.method": step.compensation.method,
        "toffoli.restitution.restoration": step.compensation.restoration,
        "toffoli.step.status": status,
      },
      status: { code: status === "failed" ? "ERROR" : "OK", ...(r && status === "failed" ? { message: r.detail } : {}) },
    });
  }

  spans.push({
    name: "toffoli.recover",
    kind: "internal",
    traceId,
    spanId: rootId,
    startTimeUnixNano: rootStart,
    endTimeUnixNano: tick(),
    attributes: {
      "gen_ai.operation.name": "recover",
      "toffoli.actions.total": plan.base.summary.total,
      "toffoli.actions.recoverable": opts.recoverable,
      "toffoli.actions.irreversible": opts.irreversible,
      "toffoli.recovery.restored": result.restored,
      "toffoli.recovery.failed": result.failed,
      "toffoli.recovery.escalated": result.escalated,
      "toffoli.recovery.confidence": conf,
      "toffoli.recovery.fully_recoverable": plan.base.summary.fullyRecoverable,
      "toffoli.pivot.action_id": plan.base.summary.pivotActionId ?? "none",
    },
    status: { code: "OK" },
  });

  return spans;
}

/** OTLP-compatible JSON envelope (resourceSpans → scopeSpans → spans). */
export function toOtlp(spans: Span[]): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "toffoli" } }] },
        scopeSpans: [{ scope: { name: "toffoli.recovery", version: "0.1.0" }, spans: spans.map(otlpSpan) }],
      },
    ],
  };
}

function otlpSpan(s: Span): unknown {
  const attrs = Object.entries(s.attributes).map(([key, v]) => ({ key, value: otlpValue(v) }));
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
    name: s.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: s.startTimeUnixNano,
    endTimeUnixNano: s.endTimeUnixNano,
    attributes: attrs,
    status: { code: s.status.code === "ERROR" ? 2 : 1, ...(s.status.message ? { message: s.status.message } : {}) },
  };
}

function otlpValue(v: AttrValue): unknown {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  return Number.isInteger(v) ? { intValue: v } : { doubleValue: v };
}

/** A zero-setup console exporter — a compact one-line-per-span view. */
export const consoleExporter: SpanExporter = (spans) => {
  for (const s of spans) {
    const a = s.attributes;
    const summary = s.name === "toffoli.recover"
      ? `confidence=${a["toffoli.recovery.confidence"]} restored=${a["toffoli.recovery.restored"]} escalated=${a["toffoli.recovery.escalated"]}`
      : s.name === "toffoli.classify"
        ? `${a["toffoli.action.id"]} → ${a["toffoli.classification"]}`
        : `${a["toffoli.action.id"]} ${a["toffoli.restitution.method"]} [${a["toffoli.step.status"]}]`;
    console.log(`  ${s.status.code === "ERROR" ? "✗" : "·"} ${s.name.padEnd(20)} ${summary}`);
  }
};

/** Write the spans as an OTLP JSON file (consumable by any OpenTelemetry backend). */
export function fileExporter(path: string): SpanExporter {
  return (spans) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(toOtlp(spans), null, 2));
  };
}
