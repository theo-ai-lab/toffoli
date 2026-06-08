import { describe, it, expect } from "vitest";
import { buildRecoveryCase } from "../exec/recover";
import { execute } from "../exec/executor";
import { classifyDeterministic } from "../engine/classify";
import { recordRecovery, recoveryConfidence, toOtlp } from "./tracer";
import type { RecoveryResult as ExecResult } from "../exec/executor";

describe("recovery telemetry (OpenTelemetry-shaped spans)", () => {
  const { world, actions, plan } = buildRecoveryCase();
  const result = execute(plan, world);
  const recoverable = actions.map((a) => classifyDeterministic(a)).filter((c) => c?.class === "REVERSIBLE" || c?.class === "COMPENSABLE").length;
  const spans = recordRecovery(plan, result, { recoverable, irreversible: 2 });
  const root = spans.find((s) => s.name === "toffoli.recover")!;

  it("emits a root recover span carrying the recovery summary attributes", () => {
    expect(root.attributes["toffoli.recovery.confidence"]).toBe(1);
    expect(root.attributes["toffoli.recovery.restored"]).toBe(4);
    expect(root.attributes["toffoli.recovery.escalated"]).toBe(2);
    expect(root.attributes["toffoli.pivot.action_id"]).not.toBe("none");
    expect(root.parentSpanId).toBeUndefined();
  });

  it("emits a classify span per action, parented to the root", () => {
    const cls = spans.filter((s) => s.name === "toffoli.classify");
    expect(cls).toHaveLength(actions.length);
    expect(cls.every((s) => s.parentSpanId === root.spanId)).toBe(true);
    expect(cls.every((s) => typeof s.attributes["toffoli.classification"] === "string")).toBe(true);
    expect(cls.every((s) => s.traceId === root.traceId)).toBe(true);
  });

  it("emits a compensate span per executed step with a restoration guarantee + status", () => {
    const comp = spans.filter((s) => s.name === "toffoli.compensate");
    expect(comp.length).toBe(result.steps.length);
    expect(comp.every((s) => ["exact", "semantic", "none"].includes(String(s.attributes["toffoli.restitution.restoration"])))).toBe(true);
  });

  it("recoveryConfidence = restored / recoverable", () => {
    expect(recoveryConfidence({ restored: 2 } as ExecResult, 4)).toBe(0.5);
    expect(recoveryConfidence(result, 0)).toBe(1);
  });

  it("toOtlp produces a valid OTLP envelope (resourceSpans → scopeSpans → spans)", () => {
    const otlp = toOtlp(spans) as { resourceSpans: { scopeSpans: { spans: { name: string; attributes: { key: string }[] }[] }[] }[] };
    const emitted = otlp.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(emitted.length).toBe(spans.length);
    const r = emitted.find((s) => s.name === "toffoli.recover")!;
    expect(r.attributes.some((a) => a.key === "toffoli.recovery.confidence")).toBe(true);
  });
});
