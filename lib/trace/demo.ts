/**
 * Toffoli — recovery telemetry demo. `npm run trace`.
 *
 * Runs the canonical recovery scenario, emits OpenTelemetry-shaped spans to the console, and writes
 * an OTLP JSON file you can ship to any OpenTelemetry backend (LangSmith, AgentOps, Jaeger, …).
 */

import { buildRecoveryCase } from "../exec/recover";
import { execute } from "../exec/executor";
import { classifyDeterministic } from "../engine/classify";
import { recordRecovery, consoleExporter, fileExporter } from "./tracer";

const { world, actions, plan } = buildRecoveryCase();
const result = execute(plan, world);

const classifications = actions.map((a) => classifyDeterministic(a));
const recoverable = classifications.filter((c) => c?.class === "REVERSIBLE" || c?.class === "COMPENSABLE").length;
const irreversible = classifications.filter((c) => c?.class === "IRREVERSIBLE").length;

const spans = recordRecovery(plan, result, { recoverable, irreversible });

console.log(`\n  TOFFOLI — recovery telemetry (OpenTelemetry-shaped spans)\n  ${"─".repeat(60)}`);
consoleExporter(spans);

const out = "traces/recovery.otlp.json";
fileExporter(out)(spans);
console.log(`  ${"─".repeat(60)}`);
console.log(`  wrote ${spans.length} spans → ${out} (OTLP JSON; ship to any OTel backend)`);
console.log(`  point at LangSmith / AgentOps: see docs/OBSERVABILITY.md\n`);
