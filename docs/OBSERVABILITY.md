# Toffoli — Observability

A production recovery system has to be *watchable* — a team should see "Toffoli classified 6
actions, restored 4, escalated 2 (confidence 1.0)" in the tool they already use. So Toffoli emits
its recovery loop as **OpenTelemetry-shaped spans** (`lib/trace/tracer.ts`). `npm run trace` prints
them and writes an OTLP JSON file.

## The spans

| Span | One per | Key attributes |
|---|---|---|
| `toffoli.recover` (root) | run | `toffoli.recovery.confidence`, `.restored`, `.failed`, `.escalated`, `.fully_recoverable`, `toffoli.pivot.action_id` |
| `toffoli.classify` | action | `toffoli.classification`, `toffoli.llm_assisted`, `toffoli.confidence`, `toffoli.rule_ref` |
| `toffoli.compensate` | executed step | `toffoli.restitution.method`, `toffoli.restitution.restoration` (exact/semantic), `toffoli.step.status` |

> **Honest framing.** The OpenTelemetry GenAI semantic conventions do **not** define rollback/undo
> attributes. The `toffoli.*` keys above are therefore **custom attributes**, clearly namespaced —
> not a claimed standard. The `gen_ai.operation.name` keys are the standard ones. `recovery.confidence`
> is defined as `restored / recoverable` for the run (1.0 = fully reversed).

## Sending them somewhere

The output is the standard OTLP span shape (`resourceSpans → scopeSpans → spans`), so it is consumable
by any OpenTelemetry-based backend. Two exporters ship here and run with zero setup:

- `consoleExporter` — the one-line-per-span view `npm run trace` prints.
- `fileExporter(path)` — writes `traces/recovery.otlp.json`.

To view them in **LangSmith** or **AgentOps** (both real agent-observability platforms), forward the
same spans via that platform's tracing / custom-instrumentation API, or via an OTLP exporter where the
backend accepts OTLP — the span model is unchanged. The `SpanExporter` type is the single seam to add
such an adapter; nothing in the engine depends on it. This keeps the engine dependency-free while
making the recovery loop a first-class, shippable telemetry stream.
