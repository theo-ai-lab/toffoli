/**
 * Toffoli — the self-healing agent loop (the hand-rolled tool-use driver).
 *
 * A live agent does work by calling tools; Toffoli's job is to make that work RECOVERABLE. This
 * module is the loop that ties the two together end to end:
 *
 *   plan → call a tool → observe → run the genuine action(s) through classify → plan → safeExecute
 *        → on damage/failure AUTONOMOUSLY recover → feed the recovery back to the model → finish.
 *
 * It is a hand-rolled `messages.create` loop (not the Agents SDK): we send the tools, and while the
 * model returns `stop_reason === "tool_use"` we execute each `tool_use` block against the world,
 * accumulate the real `AgentAction`s the tools performed into a run log, and return `tool_result`
 * blocks for the next turn — exactly the shape judge.ts uses, with `tools` swapped in for the
 * judge's single `output_config`.
 *
 * The SELF-HEALING seam: after any turn whose tools reported they damaged state (or errored), the
 * loop classifies the accumulated run, plans the resumable restitution, and runs it through the
 * SAFE executor with `autoConfirm` — which restores ONLY the policy-auto-eligible compensations
 * unattended and escalates the irreversible remainder. The recovery summary is fed back to the
 * model as part of the triggering tool_result, so the agent can retry the step correctly. The
 * irreversible remainder is the ONLY thing handed to a human — never auto-undone.
 *
 * The model is injected behind a narrow `AgentModel` function type, so a deterministic STUB drives
 * the whole loop in tests with NO API key, and `claudeAgentModel()` is the live driver. The loop
 * itself never reaches for the network.
 *
 * Reuses @anthropic-ai/sdk exactly as judge.ts does (env-gated client construction). Otherwise zero
 * extra dependencies.
 */

import Anthropic from "@anthropic-ai/sdk";
import { classifyAction } from "../engine/restitute";
import { planResumable } from "../engine/resumable";
import type { ReversibilityJudge } from "../engine/judge";
import type { AgentAction, Classification } from "../engine/types";
import { safeExecute, type RuntimeReport } from "../runtime/safe-executor";
import { SANDBOX_AUTO_POLICY, type AutoExecutePolicy } from "../runtime/policy";
import type { ExecutionMode } from "../runtime/mode";
import type { OversightRecord } from "../runtime/escalation";
import { executeTool, type AgentWorld, type ToolDef, type ToolSet } from "./tools";
import { RecoveryMemory, faultSignature } from "./memory";

// ── the model wire shape (a narrow, stubbable mirror of the Messages API) ───────

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ModelMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}
export interface ModelRequest {
  system: string;
  tools: ToolDef[];
  messages: ModelMessage[];
}
export interface ModelResponse {
  /** "tool_use" keeps the loop running; anything else ends it (end_turn / max_tokens / refusal). */
  stop_reason: string;
  content: Array<TextBlock | ToolUseBlock>;
}

/** A model is any async function from a request to a response — the only seam the loop depends on. */
export type AgentModel = (req: ModelRequest) => Promise<ModelResponse>;

// ── the live Claude-backed model (same client discipline as the judge) ──────────

export interface ClaudeAgentModelOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/** Build a live model backed by Claude. Gated: throws at call time if no key is present. */
export function claudeAgentModel(opts: ClaudeAgentModelOptions = {}): AgentModel {
  const model = opts.model ?? process.env["TOFFOLI_AGENT_MODEL"] ?? "claude-haiku-4-5";
  const maxTokens = opts.maxTokens ?? 1024;
  const timeout = opts.timeoutMs ?? 30_000;

  return async (req: ModelRequest): Promise<ModelResponse> => {
    const apiKey = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new Error("claudeAgentModel: no ANTHROPIC_API_KEY (inject a stub AgentModel to run offline)");

    const client = new Anthropic({ apiKey, maxRetries: 1, timeout });
    const res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: req.system,
      // Same untrusted-input posture as the judge: tool RESULTS we feed back are world-derived data,
      // not instructions. Tool descriptions are author-controlled.
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) as unknown as Anthropic.Tool[],
      messages: req.messages as unknown as Anthropic.MessageParam[],
    });

    const content: Array<TextBlock | ToolUseBlock> = [];
    for (const b of res.content) {
      if (b.type === "text") content.push({ type: "text", text: b.text });
      else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
    }
    return { stop_reason: res.stop_reason ?? "end_turn", content };
  };
}

// ── a scripted stub model (deterministic; drives the loop with no key) ───────────

/** Returns each scripted turn in order; after the script ends it stops the loop with a text turn. */
export function scriptedModel(turns: ModelResponse[]): AgentModel {
  let i = 0;
  return async () => {
    const next = turns[i++];
    return next ?? { stop_reason: "end_turn", content: [{ type: "text", text: "(no further action)" }] };
  };
}

export function sayText(text: string): TextBlock {
  return { type: "text", text };
}
export function toolUse(id: string, name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}
/** Build one assistant turn; `stop_reason` is "tool_use" iff it requests at least one tool. */
export function assistantTurn(...content: Array<TextBlock | ToolUseBlock>): ModelResponse {
  return { stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", content };
}

// ── the loop ────────────────────────────────────────────────────────────────────

/** One recovery pass Toffoli ran in response to a damage/failure event. */
export interface RecoveryOutcome {
  /** The tool whose result triggered the sweep. */
  trigger: string;
  report: RuntimeReport;
  /** Recoverable compensations auto-executed back to baseline. */
  restored: number;
  /** The irreversible remainder handed to a human (never auto-undone). */
  escalations: OversightRecord[];
  /** The fault signature this recovery was keyed under (shape of the new damage + trigger). */
  signature: string;
  /** True iff a known-good strategy was recalled from memory and the re-planning step was skipped. */
  fromMemory: boolean;
  /** Per-action classifications served from memory instead of re-derived — the re-plan steps avoided. */
  classificationsReused: number;
  /** Wall-clock time spent in this recovery pass (ms) — first-fault vs repeat-fault is the metric. */
  latencyMs: number;
}

/** Cross-run memory's headline: repeat faults are handled faster because the strategy is recalled. */
export interface RepeatFaultMetric {
  /** Recoveries this run that reused a known-good strategy from memory (a repeat fault handled). */
  repeatFaultsHandled: number;
  /** Total re-plan steps (per-action classifications) avoided by memory across the run. */
  classificationsAvoided: number;
  /** Latency of the first cold (re-planned) recovery of a signature that later recurred, if any. */
  firstFaultLatencyMs: number | null;
  /** Latency of the first memory-served recovery of that same signature, if any. */
  repeatFaultLatencyMs: number | null;
}

export type AgentEventKind = "model-text" | "tool-call" | "tool-result" | "recovery" | "finish";
export interface AgentEvent {
  kind: AgentEventKind;
  detail: string;
}

export interface AgentLoopOptions {
  model: AgentModel;
  world: AgentWorld;
  tools: ToolSet;
  /** The user's goal (the first user message). */
  goal: string;
  system?: string;
  /** Optional residual judge for classification (gated; unused when the rules decide everything). */
  judge?: ReversibilityJudge;
  /** Hard cap on model turns (loop-safety). Default 12. */
  maxTurns?: number;
  /** Auto-execution policy for the unattended recovery. Default SANDBOX_AUTO_POLICY. */
  policy?: AutoExecutePolicy;
  /**
   * Cross-run recovery memory. Inject a shared/file-backed instance to carry learned recovery
   * strategies ACROSS runs; omit to get an ephemeral per-run store (still serves within-run repeat
   * faults). A memory the loop creates itself is closed when the run ends; an injected one is not.
   */
  memory?: RecoveryMemory;
  /** Execution mode for recovery. Default "sandbox" (the in-memory world). */
  mode?: ExecutionMode;
  /** Unattended autonomy for recovery (run policy-auto-eligible steps; escalate the rest). Default true. */
  autoConfirm?: boolean;
  /** Injected env for the kill-switch (honored by safeExecute). Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injected clock for deterministic escalation records. */
  clock?: () => string;
  onEvent?: (e: AgentEvent) => void;
}

export interface AgentRunResult {
  /** Every genuine mutation across the run (the run log fed to the classifier). */
  actions: AgentAction[];
  /** Every recovery pass the loop ran. */
  recoveries: RecoveryOutcome[];
  /** The model's last text (its closing summary), if any. */
  finalText: string;
  turns: number;
  /** True iff the loop ended because the model stopped requesting tools (not the turn cap). */
  finished: boolean;
  /** The pooled irreversible remainder across all recoveries — the only thing a human must see. */
  escalations: OversightRecord[];
  /** Cross-run memory metric: how repeat-fault recovery improved over the first occurrence. */
  memory: RepeatFaultMetric;
}

const DEFAULT_SYSTEM = `You are an autonomous operations agent with a built-in undo layer (Toffoli).
Complete the user's goal by calling the provided tools; after each call you see its result.

If a tool reports it DAMAGED live data, Toffoli AUTOMATICALLY recovers the recoverable effects back
to the pre-damage baseline and escalates anything irreversible to a human — you will see a
"TOFFOLI AUTO-RECOVERY" note in that tool's result. When you see one, do not repeat the mistake:
retry the step correctly, operating ONLY on the records you were actually asked to touch.

When the goal is genuinely met, call the finish tool with a one-line summary. Never claim a success
you cannot back up.`;

/**
 * Run the self-healing agent loop to completion (or the turn cap).
 *
 * Each turn: ask the model; if it requested tools, execute each against the world and collect the
 * real actions + tool_results; if any tool reported damage/error, run the recovery pipeline over the
 * accumulated run and splice its summary into the triggering tool_result so the model can self-correct.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentRunResult> {
  const maxTurns = opts.maxTurns ?? 12;
  const policy = opts.policy ?? SANDBOX_AUTO_POLICY;
  const mode: ExecutionMode = opts.mode ?? "sandbox";
  const autoConfirm = opts.autoConfirm ?? true;
  const emit = opts.onEvent ?? (() => {});

  // Cross-run memory: use the injected store (carries strategies across runs) or an ephemeral one we
  // own and close at the end. Either way the loop consults it on every fault and records the outcome.
  const memory = opts.memory ?? new RecoveryMemory();
  const ownsMemory = opts.memory === undefined;

  const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: opts.goal }] }];
  const runLog: AgentAction[] = [];
  const recoveries: RecoveryOutcome[] = [];
  const escalations: OversightRecord[] = [];
  let recoveredThrough = 0; // run-log length already swept, so a clean turn never re-recovers
  let finalText = "";
  let finished = false;
  let turns = 0;

  try {
  while (turns < maxTurns) {
    turns++;
    const res = await opts.model({ system: opts.system ?? DEFAULT_SYSTEM, tools: opts.tools.defs, messages });
    messages.push({ role: "assistant", content: res.content });

    const text = res.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    if (text) {
      finalText = text;
      emit({ kind: "model-text", detail: text });
    }

    const toolUses = res.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      finished = true; // the model stopped on its own (end_turn / refusal / max_tokens)
      break;
    }

    const results: ToolResultBlock[] = [];
    let damaged = false;
    let trigger = "";
    for (const tu of toolUses) {
      emit({ kind: "tool-call", detail: `${tu.name}(${JSON.stringify(tu.input)})` });
      const r = executeTool(opts.tools, tu.name, tu.input, opts.world);
      runLog.push(...r.actions);
      emit({ kind: "tool-result", detail: r.output });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: r.output, is_error: r.isError });
      if (r.damaged || r.isError) {
        damaged = true;
        if (!trigger) trigger = tu.name;
      }
      if (r.finished) finished = true;
    }

    // Self-healing: only on a damage/failure event, and only over actions not already swept.
    if (damaged && runLog.length > recoveredThrough) {
      const outcome = await recover(runLog, recoveredThrough, trigger, memory, opts, mode, policy, autoConfirm);
      recoveries.push(outcome);
      escalations.push(...outcome.escalations);
      recoveredThrough = runLog.length;
      const note = recoveryNote(outcome);
      const last = results[results.length - 1];
      if (last) last.content = `${last.content}\n\n${note}`;
      emit({ kind: "recovery", detail: note });
    }

    messages.push({ role: "user", content: results });
    if (finished) break;
  }

  emit({ kind: "finish", detail: finalText || "(loop ended)" });
  return { actions: runLog, recoveries, finalText, turns, finished, escalations, memory: repeatFaultMetric(recoveries) };
  } finally {
    if (ownsMemory) memory.close();
  }
}

/** Roll the per-recovery memory signals up into the run-level repeat-fault metric. */
function repeatFaultMetric(recoveries: RecoveryOutcome[]): RepeatFaultMetric {
  const repeatFaultsHandled = recoveries.filter((r) => r.fromMemory).length;
  const classificationsAvoided = recoveries.reduce((n, r) => n + r.classificationsReused, 0);
  const firstRepeat = recoveries.find((r) => r.fromMemory);
  // Pair the first memory-served recovery with the first cold (re-planned) recovery of that SAME
  // signature, so the metric compares like with like: identical fault, with vs without memory.
  const firstCold = firstRepeat ? recoveries.find((r) => r.signature === firstRepeat.signature && !r.fromMemory) : undefined;
  return {
    repeatFaultsHandled,
    classificationsAvoided,
    firstFaultLatencyMs: firstCold ? firstCold.latencyMs : null,
    repeatFaultLatencyMs: firstRepeat ? firstRepeat.latencyMs : null,
  };
}

/**
 * Classify the accumulated run, plan the resumable restitution, and run it through the safe executor —
 * consulting cross-run MEMORY first so a repeat fault skips the re-planning step.
 *
 * The fault signature is keyed on the NEW damage slice (the actions since the last sweep) — the unit
 * that recurs identically across runs. On a known-good HIT we reuse the cached verdicts for that slice
 * (re-stamped onto this run's action ids) and only re-classify the already-swept, idempotent prefix;
 * on a MISS we classify the whole run as before. Execution stays over the WHOLE run log either way
 * (its idempotency keys make replays no-ops, so a prior sweep's failed step still gets retried).
 * The outcome is ALWAYS recorded so the next identical fault can be served from memory.
 */
async function recover(
  runLog: AgentAction[],
  recoveredThrough: number,
  trigger: string,
  memory: RecoveryMemory,
  opts: AgentLoopOptions,
  mode: ExecutionMode,
  policy: AutoExecutePolicy,
  autoConfirm: boolean,
): Promise<RecoveryOutcome> {
  const start = performance.now();
  const faultSlice = runLog.slice(recoveredThrough);
  const signature = faultSignature(faultSlice, trigger);
  const prior = memory.recall(signature);

  let classifications: Classification[];
  let classificationsReused = 0;
  if (prior && prior.classifications.length === faultSlice.length) {
    // KNOWN-GOOD repeat fault: take the recalled strategy directly — skip re-planning the recurring
    // slice. Re-stamp the cached verdicts onto this run's ids; only the swept prefix is re-classified.
    const prefix = await Promise.all(runLog.slice(0, recoveredThrough).map((a) => classifyAction(a, opts.judge)));
    const reused = faultSlice.map((a, i) => ({ ...prior.classifications[i]!, actionId: a.id }));
    classifications = [...prefix, ...reused];
    classificationsReused = faultSlice.length;
  } else {
    classifications = await Promise.all(runLog.map((a) => classifyAction(a, opts.judge)));
  }

  const rp = planResumable(runLog, classifications);
  const report = safeExecute(rp, opts.world, {
    autoConfirm,
    policy,
    mode,
    env: opts.env ?? process.env,
    clock: opts.clock,
    runId: "agent-self-heal",
    caller: "agent-loop",
  });

  // Record the fault-slice verdicts so an identical fault can be recovered from memory next time.
  memory.record(signature, {
    classifications: classifications.slice(recoveredThrough),
    restored: report.restored,
    escalated: report.escalations.length,
    fabricationPass: report.fabricationCheck.pass,
  });

  return {
    trigger,
    report,
    restored: report.restored,
    escalations: report.escalations,
    signature,
    fromMemory: classificationsReused > 0,
    classificationsReused,
    latencyMs: performance.now() - start,
  };
}

/** The human-legible note spliced back into the triggering tool_result so the agent can self-correct. */
function recoveryNote(o: RecoveryOutcome): string {
  const escCount = o.escalations.length;
  const lines = [
    `TOFFOLI AUTO-RECOVERY (triggered by ${o.trigger}):`,
    `  restored ${o.restored} recoverable action(s) to the pre-damage baseline.`,
    escCount > 0
      ? `  escalated ${escCount} irreversible action(s) to a human (NOT auto-undone):`
      : "  no irreversible remainder.",
    ...o.escalations.map((e) => `    - [${e.severity}] ${e.forActionId}: ${e.decision}`),
    `  anti-fabrication check: ${o.report.fabricationCheck.pass ? "PASS" : "FAIL"}.`,
    "  Now retry the step correctly — operate only on the records you were asked to touch.",
  ];
  return lines.join("\n");
}
