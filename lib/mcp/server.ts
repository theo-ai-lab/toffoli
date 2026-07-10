/**
 * Toffoli — the MCP server. `npm run mcp`.
 *
 * Exposes Toffoli's engine as live Model-Context-Protocol tools an agent/host can call:
 *
 *   - toffoli.checkpoint — snapshot the recovery world BEFORE a risky step, returning a checkpointId
 *                          a later recover can verify it restored to. Read-only.
 *   - toffoli.classify   — "is this action reversible?" One AgentAction → its reversibility class,
 *                          via the deterministic rules first, the gated LLM judge only on the residual.
 *   - toffoli.recover    — plan + (only when authorized) execute the undo of a run, THROUGH the
 *                          safe-executor floor: the kill-switch (TOFFOLI_EXECUTE_DISABLED) and the
 *                          plan-bound confirm-token gating ALWAYS apply. Plan-only by default.
 *
 * ── TRANSPORT ──
 * `@modelcontextprotocol/sdk` is NOT a dependency of this repo (zero-extra-dep ethos). So the
 * default transport is a HAND-ROLLED stdio JSON-RPC 2.0 loop (node:readline only, zero deps),
 * implementing initialize / tools/list / tools/call. If the SDK is later installed, `createSdkServer`
 * picks it up automatically (it is lazily, guardedly imported so this file type-checks WITHOUT it).
 *
 *   DEFERRED INSTALL (optional): `npm i @modelcontextprotocol/sdk` to use the official transport.
 *   Until then everything runs on the hand-rolled `serveStdio()` — no install required.
 *
 * The tool handlers (`handleCheckpoint` / `handleClassify` / `handleRecover`) and the protocol
 * dispatcher (`handleRpcMessage`) are exported directly so they are unit-testable WITHOUT the SDK
 * and without real stdio.
 *
 * ── WIRING NOTE ──
 * The server holds ONE recovery world (the live system adapter). The default is the in-memory
 * `World` (lib/exec/world.ts); a real deployment injects a real adapter (FsWorld, or a SqlWorld)
 * via `serveStdio({ world })` so checkpoint snapshots — and recover acts on — the actual system.
 *
 * Zero runtime dependencies (node:crypto + node:readline only).
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  classifyAction,
  claudeJudge,
  isJudgeAvailable,
  planResumable,
  type ActionOp,
  type AgentAction,
  type Classification,
  type ResourceRef,
  type ReversibilityJudge,
} from "../engine/index";
import type { ExecutionMode } from "../runtime/mode";
import { DEFAULT_AUTO_POLICY, SANDBOX_AUTO_POLICY, type AutoExecutePolicy } from "../runtime/policy";
import { safeExecute, type SafeExecuteOptions } from "../runtime/safe-executor";
import { World, type RecoveryWorld, type WorldState } from "../exec/world";

// ── identity ──────────────────────────────────────────────────────────────────
const SERVER_NAME = "toffoli-mcp";
const SERVER_VERSION = "0.1.0";
/** A widely-supported MCP protocol revision; the client's requested version is echoed when present. */
const PROTOCOL_VERSION = "2025-06-18";

// ── dependency surface (injectable for tests and for wiring a real adapter) ─────

export interface CheckpointRecord {
  id: string;
  label?: string;
  takenAt: string;
  snapshot: WorldState;
}

export interface ToffoliMcpDeps {
  /** The live recovery world checkpoint snapshots and recover acts on. */
  world: RecoveryWorld;
  /** Checkpoint store: id → snapshot taken before a risky step. */
  checkpoints: Map<string, CheckpointRecord>;
  /** The gated LLM judge for the residual the deterministic rules abstain on (omit → deterministic-only). */
  judge?: ReversibilityJudge;
  /** Default auto-execution policy for recover when the call doesn't name one. */
  defaultPolicy?: AutoExecutePolicy;
  /** Injected env so the kill-switch is deterministic in tests; passed straight to safeExecute. */
  env?: NodeJS.ProcessEnv;
  /** Injected id/clock for deterministic checkpoint records in tests. */
  newId?: () => string;
  now?: () => string;
}

/**
 * Build a default dependency set. The world is the in-memory sandbox; inject a real adapter for a
 * deployment. The judge is enabled only when a key is present (the engine's own gating), so the
 * server is deterministic and cost-free offline.
 */
export function createDeps(overrides: Partial<ToffoliMcpDeps> = {}): ToffoliMcpDeps {
  const judge = "judge" in overrides ? overrides.judge : isJudgeAvailable() ? claudeJudge() : undefined;
  const deps: ToffoliMcpDeps = {
    world: overrides.world ?? new World(),
    checkpoints: overrides.checkpoints ?? new Map<string, CheckpointRecord>(),
    env: overrides.env ?? process.env,
    newId: overrides.newId ?? randomUUID,
    now: overrides.now ?? (() => new Date().toISOString()),
  };
  if (judge) deps.judge = judge;
  if (overrides.defaultPolicy) deps.defaultPolicy = overrides.defaultPolicy;
  return deps;
}

// ── input validation (the JSON-RPC boundary is untrusted) ───────────────────────

class ToolInputError extends Error {}

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ToolInputError("expected a JSON object");
  return v as Record<string, unknown>;
}
function asRecordOrEmpty(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asString(v: unknown, field: string): string {
  if (typeof v !== "string") throw new ToolInputError(`'${field}' must be a string`);
  return v;
}
function asOptString(v: unknown, field: string): string | undefined {
  return v === undefined || v === null ? undefined : asString(v, field);
}
function asOptBool(v: unknown, field: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ToolInputError(`'${field}' must be a boolean`);
  return v;
}
function parseMode(v: unknown): ExecutionMode | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === "dry-run" || v === "sandbox" || v === "execute") return v;
  throw new ToolInputError("'mode' must be one of 'dry-run' | 'sandbox' | 'execute'");
}
function parsePolicyName(v: unknown): "default" | "sandbox" | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === "default" || v === "sandbox") return v;
  throw new ToolInputError("'policy' must be one of 'default' | 'sandbox'");
}

/** Validate the AgentAction adapter record. Only id+tool are required; structured fields pass
 *  through. Exported: the CLI's `classify` reads the same untrusted shape and shares this validator. */
export function parseAgentAction(v: unknown): AgentAction {
  const r = asRecord(v);
  const action: AgentAction = { id: asString(r["id"], "action.id"), tool: asString(r["tool"], "action.tool") };
  if (r["op"] !== undefined) action.op = r["op"] as ActionOp;
  if (r["params"] !== undefined) action.params = asRecord(r["params"]);
  if (r["target"] !== undefined) action.target = asRecord(r["target"]) as unknown as ResourceRef;
  if ("idempotencyKey" in r) action.idempotencyKey = r["idempotencyKey"] as string | null;
  if (r["effect"] !== undefined) action.effect = asString(r["effect"], "action.effect");
  if (r["at"] !== undefined) action.at = asString(r["at"], "action.at");
  if (r["committed"] !== undefined) action.committed = asOptBool(r["committed"], "action.committed");
  if (r["agentId"] !== undefined) action.agentId = asString(r["agentId"], "action.agentId");
  if (r["runId"] !== undefined) action.runId = asString(r["runId"], "action.runId");
  return action;
}

// ── the three tool handlers (exported for unit tests) ───────────────────────────

export interface CheckpointResult {
  checkpointId: string;
  label?: string;
  takenAt: string;
  snapshot: WorldState;
}

/** Snapshot the world before a risky step, store it under a generated id, and return it. */
export function handleCheckpoint(deps: ToffoliMcpDeps, raw: unknown): CheckpointResult {
  const r = raw === undefined || raw === null ? {} : asRecord(raw);
  const label = asOptString(r["label"], "label");
  const snapshot = deps.world.snapshot();
  const id = (deps.newId ?? randomUUID)();
  const takenAt = (deps.now ?? (() => new Date().toISOString()))();
  const record: CheckpointRecord = { id, takenAt, snapshot };
  if (label !== undefined) record.label = label;
  deps.checkpoints.set(id, record);
  const result: CheckpointResult = { checkpointId: id, takenAt, snapshot };
  if (label !== undefined) result.label = label;
  return result;
}

export interface ClassifyResult {
  classification: Classification;
  /** Convenience answer to "is this action reversible?" */
  recoverable: boolean;
  /** True iff only a human can put it back (IRREVERSIBLE). */
  requiresHuman: boolean;
  /** True iff the gated LLM judge — not a deterministic rule — produced the verdict. */
  judged: boolean;
}

/** Classify one action through the cascade (rules → gated judge → fail-safe-to-IRREVERSIBLE). */
export async function handleClassify(deps: ToffoliMcpDeps, raw: unknown): Promise<ClassifyResult> {
  const r = asRecord(raw);
  if (r["action"] === undefined) throw new ToolInputError("toffoli.classify requires an 'action' object");
  const deterministicOnly = asOptBool(r["deterministicOnly"], "deterministicOnly") ?? false;
  const action = parseAgentAction(r["action"]);
  const judge = deterministicOnly ? undefined : deps.judge;
  const classification = await classifyAction(action, judge);
  return {
    classification,
    recoverable: classification.class === "REVERSIBLE" || classification.class === "COMPENSABLE",
    requiresHuman: classification.class === "IRREVERSIBLE",
    judged: classification.llmAssisted,
  };
}

export interface RecoverResult {
  /** True iff the floor actually mutated the world (a valid token / autoConfirm + a mutating mode). */
  executed: boolean;
  /** The plan-bound token a caller re-presents (as confirmToken) to authorize executing this exact plan. */
  confirmToken: string;
  classifications: Classification[];
  planSummary: { steps: number; escalations: number; conflicts: number };
  /** The full safe-executor report: phase, mode, per-step status, escalations, anti-fabrication check. */
  report: ReturnType<typeof safeExecute>;
  afterSnapshot: WorldState;
  /** Verification against a prior checkpoint, when `checkpointId` was supplied. */
  checkpoint?: { id: string; found: boolean; takenAt?: string; recoverableMatchesCheckpoint?: boolean; baseline?: WorldState };
}

/**
 * Plan and (only when authorized) execute the undo of a run, THROUGH safeExecute. Plan-only by
 * default — mutates nothing, escalates the irreversible remainder, and returns the confirmToken a
 * caller re-presents to execute. `autoConfirm:true` runs only the policy-auto-eligible subset.
 */
export async function handleRecover(deps: ToffoliMcpDeps, raw: unknown): Promise<RecoverResult> {
  const r = asRecord(raw);
  const actionsRaw = r["actions"];
  if (!Array.isArray(actionsRaw) || actionsRaw.length === 0) {
    throw new ToolInputError("toffoli.recover requires a non-empty 'actions' array");
  }
  const actions: AgentAction[] = actionsRaw.map((a, i) => {
    try {
      return parseAgentAction(a);
    } catch (e) {
      throw new ToolInputError(`actions[${i}]: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  const deterministicOnly = asOptBool(r["deterministicOnly"], "deterministicOnly") ?? false;
  const mode = parseMode(r["mode"]);
  const confirmToken = asOptString(r["confirmToken"], "confirmToken");
  const autoConfirm = asOptBool(r["autoConfirm"], "autoConfirm");
  const policyName = parsePolicyName(r["policy"]);
  const checkpointId = asOptString(r["checkpointId"], "checkpointId");

  const judge = deterministicOnly ? undefined : deps.judge;
  const classifications: Classification[] = await Promise.all(actions.map((a) => classifyAction(a, judge)));
  const rp = planResumable(actions, classifications);

  const policy: AutoExecutePolicy =
    policyName === "sandbox" ? SANDBOX_AUTO_POLICY : policyName === "default" ? DEFAULT_AUTO_POLICY : deps.defaultPolicy ?? DEFAULT_AUTO_POLICY;

  const opts: SafeExecuteOptions = { policy };
  if (deps.env) opts.env = deps.env;
  if (mode) opts.mode = mode;
  if (confirmToken !== undefined) opts.confirmToken = confirmToken;
  if (autoConfirm !== undefined) opts.autoConfirm = autoConfirm;

  const report = safeExecute(rp, deps.world, opts);
  const afterSnapshot = deps.world.snapshot();

  const result: RecoverResult = {
    executed: report.phase === "executed",
    confirmToken: report.confirmToken,
    classifications,
    planSummary: { steps: rp.steps.length, escalations: rp.escalations.length, conflicts: rp.conflicts.length },
    report,
    afterSnapshot,
  };

  if (checkpointId !== undefined) {
    const rec = deps.checkpoints.get(checkpointId);
    result.checkpoint = rec
      ? {
          id: rec.id,
          found: true,
          takenAt: rec.takenAt,
          recoverableMatchesCheckpoint: recoverableMatchesCheckpoint(afterSnapshot, rec.snapshot),
          baseline: rec.snapshot,
        }
      : { id: checkpointId, found: false };
  }

  return result;
}

/** Did recovery put the RECOVERABLE subset (files, rows, ledger net) back to the checkpoint? */
function recoverableMatchesCheckpoint(after: WorldState, baseline: WorldState): boolean {
  return sameRecord(after.files, baseline.files) && sameRecord(after.rows, baseline.rows) && after.ledgerUsd === baseline.ledgerUsd;
}
function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return false;
  return ka.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

// ── MCP tool definitions (JSON Schema; shared by both transports) ───────────────

const ACTION_SCHEMA = {
  type: "object",
  description: "A generic, tool-agnostic record of one thing an agent did.",
  properties: {
    id: { type: "string", description: "Stable id within the run." },
    tool: { type: "string", description: "The tool/function invoked, e.g. 'stripe.charge', 'email.send', 'sql.execute'." },
    op: {
      type: "string",
      enum: ["read", "create", "update", "delete", "append", "send", "pay", "publish", "deploy", "execute", "custom"],
      description: "The canonical operation, when known. Inferred from tool/params when absent.",
    },
    params: { type: "object", additionalProperties: true, description: "Structured call parameters (method, url, sql, amountUsd, recipient, ...)." },
    target: {
      type: "object",
      additionalProperties: true,
      description: "The resource touched — the basis for planning compensation.",
      properties: {
        kind: { type: "string", description: "e.g. 'file' | 'db.row' | 'payment' | 'email' | 'deployment'." },
        id: { type: "string" },
        priorState: { description: "The prior value/snapshot, if preserved — its presence makes an 'update' REVERSIBLE." },
        recoverable: { type: "boolean", description: "TRUSTED signal: an independent recoverable copy exists (backup/PITR/trash)." },
        externalized: { type: "boolean", description: "TRUSTED signal: the effect crossed a trust boundary (email sent, payment settled)." },
      },
    },
    idempotencyKey: { type: ["string", "null"], description: "A Stripe-style key. De-duplicates the action; does NOT make it reversible." },
    effect: { type: "string", description: "Free-text effect, read by the judge when the structured fields are thin." },
    at: { type: "string", description: "ISO 8601 timestamp; drives the LIFO undo order and the pivot." },
    committed: { type: "boolean", description: "Did the side effect actually commit? Defaults true." },
    agentId: { type: "string" },
    runId: { type: "string" },
  },
  required: ["id", "tool"],
  additionalProperties: false,
} as const;

export const TOOL_DEFINITIONS = [
  {
    name: "toffoli.checkpoint",
    description:
      "Snapshot the current state of the recovery world BEFORE a risky or hard-to-reverse step, so a later toffoli.recover can verify it restored to this point. Returns a checkpointId to pass to toffoli.recover. Read-only — it takes no mutating action.",
    inputSchema: {
      type: "object",
      properties: { label: { type: "string", description: "Optional human label for the checkpoint." } },
      additionalProperties: false,
    },
    annotations: { title: "Checkpoint the recovery world", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "toffoli.classify",
    description:
      "Decide whether a single agent action is reversible. Call this before performing or undoing an action to learn its reversibility class (NULLIPOTENT/REVERSIBLE/COMPENSABLE/IRREVERSIBLE), whether it can be recovered automatically, and whether it needs a human. Deterministic rules first; the gated LLM judge runs only on the residual (set deterministicOnly:true to force rules-only). An ambiguous action fails TOWARD the more severe class.",
    inputSchema: {
      type: "object",
      properties: {
        action: ACTION_SCHEMA,
        deterministicOnly: { type: "boolean", description: "Force deterministic rules only; never call the LLM judge. Default false." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { title: "Classify reversibility", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "toffoli.recover",
    description:
      "Plan and (only when authorized) execute the undo of a run of agent actions, THROUGH Toffoli's safe-executor floor: the kill-switch (env TOFFOLI_EXECUTE_DISABLED) and the plan-bound confirm-token gating ALWAYS apply. PLAN-ONLY by default — it mutates nothing and returns a confirmToken; call again with that confirmToken to execute the whole approved plan, or pass autoConfirm:true to run only the policy-auto-eligible subset unattended. Irreversible actions are never auto-undone — they are returned as escalations for a human.",
    inputSchema: {
      type: "object",
      properties: {
        actions: { type: "array", minItems: 1, items: ACTION_SCHEMA, description: "The run of actions to undo (oldest → newest)." },
        mode: { type: "string", enum: ["dry-run", "sandbox", "execute"], description: "Requested mode; the kill-switch can still force dry-run. Pairs with the wired world." },
        confirmToken: { type: "string", description: "A token bound to THIS exact plan (returned by a prior plan-only call) — authorizes executing all of it." },
        autoConfirm: { type: "boolean", description: "Unattended autonomy: run ONLY policy-auto-eligible compensations; escalate the rest. Default false." },
        deterministicOnly: { type: "boolean", description: "Classify with deterministic rules only; never call the LLM judge. Default false." },
        policy: { type: "string", enum: ["default", "sandbox"], description: "Auto-execute policy: 'default' (REVERSIBLE only) or 'sandbox' (also COMPENSABLE refunds)." },
        checkpointId: { type: "string", description: "A checkpoint id to verify the recoverable subset was restored against." },
      },
      required: ["actions"],
      additionalProperties: false,
    },
    annotations: { title: "Plan & execute restitution", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
] as const;

// ── tool dispatch (shared by the hand-rolled loop and the SDK factory) ──────────

interface ToolResultContent {
  type: "text";
  text: string;
}
export interface ToolResult {
  content: ToolResultContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

function okResult(out: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false };
}
function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Run one tool by name. Tool-execution errors come back as an isError result (MCP convention). */
export async function callToolByName(deps: ToffoliMcpDeps, name: string, args: unknown): Promise<ToolResult> {
  try {
    switch (name) {
      case "toffoli.checkpoint":
        return okResult(handleCheckpoint(deps, args));
      case "toffoli.classify":
        return okResult(await handleClassify(deps, args));
      case "toffoli.recover":
        return okResult(await handleRecover(deps, args));
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e));
  }
}

// ── hand-rolled stdio JSON-RPC 2.0 transport (zero deps) ────────────────────────

type JsonRpcId = string | number | null;
interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

function initializeResult(params: unknown): unknown {
  const r = asRecordOrEmpty(params);
  const requested = typeof r["protocolVersion"] === "string" ? (r["protocolVersion"] as string) : undefined;
  return {
    protocolVersion: requested ?? PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions:
      "Toffoli reversibility engine. checkpoint a world before risky steps; classify whether an action is reversible; recover plans/executes the undo through the safe-executor floor (kill-switch + confirm-token gating). recover is plan-only until you re-present its confirmToken.",
  };
}

/**
 * Handle one parsed JSON-RPC message. Returns the response, or null for a notification (no reply).
 * Pure over the injected deps — the whole protocol layer is testable without stdio.
 */
export async function handleRpcMessage(deps: ToffoliMcpDeps, message: unknown): Promise<JsonRpcResponse | null> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  const m = message as Record<string, unknown>;
  const idVal = m["id"];
  const id: JsonRpcId = typeof idVal === "string" || typeof idVal === "number" ? idVal : null;
  const isNotification = !("id" in m) || idVal === undefined;
  const method = m["method"];
  if (typeof method !== "string") {
    return isNotification ? null : { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request: missing 'method'" } };
  }
  const params = m["params"];

  let result: unknown;
  switch (method) {
    case "initialize":
      result = initializeResult(params);
      break;
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = { tools: TOOL_DEFINITIONS };
      break;
    case "tools/call": {
      const p = asRecordOrEmpty(params);
      const name = p["name"];
      if (typeof name !== "string") {
        result = errorResult("tools/call requires a string 'name' in params");
        break;
      }
      result = await callToolByName(deps, name, p["arguments"]);
      break;
    }
    default:
      if (method.startsWith("notifications/")) return null;
      if (isNotification) return null;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  if (isNotification) return null;
  return { jsonrpc: "2.0", id, result };
}

/** Start the hand-rolled stdio server (the zero-dependency default transport). */
export function serveStdio(overrides: Partial<ToffoliMcpDeps> = {}): void {
  const deps = createDeps(overrides);
  const rl = createInterface({ input: process.stdin, terminal: false });

  // Serialize message handling so responses are emitted in request order.
  let chain: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    chain = chain
      .then(async () => {
        const t = line.trim();
        if (!t) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(t);
        } catch {
          writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          return;
        }
        const resp = await handleRpcMessage(deps, parsed);
        if (resp) writeMessage(resp);
      })
      .catch((err) => {
        process.stderr.write(`[${SERVER_NAME}] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
      });
  });

  process.stderr.write(`[${SERVER_NAME}] hand-rolled stdio server ready (${SERVER_VERSION}; no SDK required)\n`);
}

function writeMessage(msg: JsonRpcResponse): void {
  // NDJSON: JSON.stringify escapes embedded newlines, so each message is exactly one line.
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

// ── optional: the official @modelcontextprotocol/sdk transport (lazy, guarded) ──

interface SdkServer {
  setRequestHandler(schema: unknown, handler: (req: SdkCallRequest) => Promise<unknown>): void;
  connect(transport: unknown): Promise<void>;
}
interface SdkServerCtor {
  new (info: { name: string; version: string }, opts: { capabilities: Record<string, unknown> }): SdkServer;
}
interface SdkCallRequest {
  params?: { name?: unknown; arguments?: unknown };
}

/**
 * Wire the official MCP SDK if it is installed. The SDK is imported lazily via a runtime-built
 * specifier so this file type-checks WITHOUT the package present; if it is absent the call throws a
 * clear message pointing at the zero-dep `serveStdio()` fallback.
 */
export async function createSdkServer(overrides: Partial<ToffoliMcpDeps> = {}): Promise<SdkServer> {
  const deps = createDeps(overrides);
  const base = ["@modelcontextprotocol", "sdk"];
  let serverMod: Record<string, unknown>;
  let stdioMod: Record<string, unknown>;
  let typesMod: Record<string, unknown>;
  try {
    serverMod = (await import([...base, "server", "index.js"].join("/"))) as Record<string, unknown>;
    stdioMod = (await import([...base, "server", "stdio.js"].join("/"))) as Record<string, unknown>;
    typesMod = (await import([...base, "types.js"].join("/"))) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      "@modelcontextprotocol/sdk is not installed. Run `npm i @modelcontextprotocol/sdk` to use the official transport, " +
        `or call serveStdio() — the zero-dependency hand-rolled stdio server, which needs no install. (import failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const ServerCtor = serverMod["Server"] as unknown as SdkServerCtor;
  const StdioTransportCtor = stdioMod["StdioServerTransport"] as unknown as new () => unknown;
  const listSchema = typesMod["ListToolsRequestSchema"];
  const callSchema = typesMod["CallToolRequestSchema"];

  const server = new ServerCtor({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(listSchema, async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(callSchema, async (req: SdkCallRequest) => {
    const name = typeof req.params?.name === "string" ? req.params.name : "";
    return callToolByName(deps, name, req.params?.arguments);
  });
  await server.connect(new StdioTransportCtor());
  return server;
}

// ── entrypoint: prefer the SDK transport when present, else hand-rolled stdio ────

/**
 * Resolve the recovery world for the entrypoint. By default the server runs on the in-memory
 * sandbox `World`. Set `TOFFOLI_MCP_FS_ROOT=<dir>` to back it with the real-filesystem `FsWorld`
 * rooted there — this is the documented "inject a real adapter" seam, wired to the CLI so a host
 * (lib/mcp/host.ts) can share a live backend with the server across processes. Imported lazily so
 * the default (in-memory) path never loads the disk adapter.
 */
async function resolveEntrypointDeps(): Promise<Partial<ToffoliMcpDeps>> {
  const fsRoot = process.env["TOFFOLI_MCP_FS_ROOT"];
  if (!fsRoot) return {};
  const { FsWorld } = await import("../exec/fs-world");
  process.stderr.write(`[${SERVER_NAME}] recovery world backed by FsWorld at ${fsRoot}\n`);
  return { world: new FsWorld(fsRoot) };
}

/** Start the server on stdio (exported so the `toffoli mcp` CLI shares this exact entry path). */
export async function startServer(): Promise<void> {
  const overrides = await resolveEntrypointDeps();
  try {
    await createSdkServer(overrides);
    process.stderr.write(`[${SERVER_NAME}] using @modelcontextprotocol/sdk stdio transport\n`);
  } catch {
    serveStdio(overrides);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void startServer();
}
