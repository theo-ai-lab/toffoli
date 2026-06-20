/**
 * Toffoli — the MCP stdio CLIENT (the consumer side of lib/mcp/server.ts).
 *
 * lib/mcp/server.ts exposes Toffoli as MCP tools (toffoli.checkpoint / classify / recover) over a
 * hand-rolled, zero-dependency JSON-RPC 2.0 stdio loop. This is its counterpart: a small, reusable
 * client an agent HOST drives the server with. It speaks the same wire protocol — initialize,
 * tools/list, tools/call — frames messages as NDJSON, correlates responses to requests by id, and
 * surfaces a tool's `isError` result as a thrown error.
 *
 * ── TRANSPORT SEAM ──
 * The protocol logic is pure over an injected `McpTransport` (send a line / receive lines / close).
 * Two implementations:
 *   - `ChildProcessTransport` (+ `spawnToffoliServer`) — spawns the REAL server as a child process
 *     and talks to it over its stdin/stdout. This is a true cross-process client → server round trip.
 *   - an in-process transport (see client.test.ts) — wires `send` straight into the server's
 *     `handleRpcMessage`, so the full protocol is exercised deterministically with no subprocess.
 *
 * Zero runtime dependencies (node:child_process / node:module / node:path / node:url only).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAction } from "../engine/types";
import type { CheckpointResult, ClassifyResult, RecoverResult, ToolResult } from "./server";

// ── the wire shapes (mirror lib/mcp/server.ts) ──────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: unknown;
}

export interface McpServerInfo {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  instructions?: string;
}

/**
 * The transport the client speaks over. The client owns NDJSON framing — it appends the trailing
 * newline on `send` and splits inbound chunks on newlines — so a transport only moves opaque bytes.
 */
export interface McpTransport {
  /** Write the given bytes to the server verbatim (the client has already framed them). */
  send(raw: string): void;
  /** Register the handler that receives raw inbound chunks from the server (may be partial lines). */
  onMessage(cb: (chunk: string) => void): void;
  /** Register a handler invoked when the transport closes (so pending requests can reject). */
  onClose(cb: (info: { code: number | null; signal: string | null; stderr?: string }) => void): void;
  /** Tear the transport down. */
  close(): void;
}

const PROTOCOL_VERSION = "2025-06-18";

export interface ToffoliMcpClientOptions {
  /** Per-request timeout in ms (a hung server rejects rather than hangs forever). Default 30_000. */
  requestTimeoutMs?: number;
}

/**
 * A minimal MCP client for the Toffoli server. Construct it over a transport, `initialize()`, then
 * call the typed tool wrappers. Responses are correlated to requests by a monotonic id; a tool that
 * comes back with `isError` is raised as an `McpToolError`.
 */
export class ToffoliMcpClient {
  private readonly transport: McpTransport;
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private buf = "";
  private closed = false;
  private closeInfo: { code: number | null; signal: string | null; stderr?: string } | null = null;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(transport: McpTransport, opts: ToffoliMcpClientOptions = {}) {
    this.transport = transport;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    transport.onMessage((chunk) => this.onChunk(chunk));
    transport.onClose((info) => this.onTransportClose(info));
  }

  // ── MCP lifecycle ──

  /** Perform the MCP handshake and send the `initialized` notification. Returns the server's info. */
  async initialize(): Promise<McpServerInfo> {
    const result = (await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "toffoli-host", version: "0.1.0" },
    })) as McpServerInfo;
    // Per MCP, the client confirms the handshake with a notification (no id, no response expected).
    this.notify("notifications/initialized");
    return result;
  }

  /** List the tools the server advertises. */
  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request("tools/list")) as { tools: McpToolDescriptor[] };
    return result.tools;
  }

  // ── the three Toffoli tools (typed) ──

  /** Snapshot the server's recovery world before a risky step; returns a checkpointId. */
  checkpoint(args: { label?: string } = {}): Promise<CheckpointResult> {
    return this.callTool<CheckpointResult>("toffoli.checkpoint", args);
  }

  /** Decide whether one action is reversible. */
  classify(args: { action: AgentAction; deterministicOnly?: boolean }): Promise<ClassifyResult> {
    return this.callTool<ClassifyResult>("toffoli.classify", args);
  }

  /** Plan and (only when authorized) execute the undo of a run of actions, through the safety floor. */
  recover(args: {
    actions: AgentAction[];
    mode?: "dry-run" | "sandbox" | "execute";
    confirmToken?: string;
    autoConfirm?: boolean;
    deterministicOnly?: boolean;
    policy?: "default" | "sandbox";
    checkpointId?: string;
  }): Promise<RecoverResult> {
    return this.callTool<RecoverResult>("toffoli.recover", args);
  }

  /** Call a tool by name; an `isError` tool result is raised as an `McpToolError`. */
  async callTool<T>(name: string, args: unknown): Promise<T> {
    const result = (await this.request("tools/call", { name, arguments: args })) as ToolResult;
    if (result.isError) {
      const text = result.content?.map((c) => c.text).join("\n") ?? "tool reported an error";
      throw new McpToolError(name, text);
    }
    if (result.structuredContent === undefined) {
      throw new McpToolError(name, "tool returned no structuredContent");
    }
    return result.structuredContent as T;
  }

  /** Reject all in-flight requests and tear the transport down. */
  close(): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("MCP client closed"));
    }
    this.pending.clear();
    this.transport.close();
  }

  // ── JSON-RPC plumbing ──

  /** Send a request and resolve with its `result` (or reject on a JSON-RPC error / timeout / close). */
  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`MCP client is closed; cannot call ${method}`));
    const id = this.nextId++;
    const payload = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' (id ${id}) timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      // Do not let a pending timer keep the event loop (and the demo process) alive on its own.
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(`${JSON.stringify(payload)}\n`);
    });
  }

  /** Fire-and-forget notification (no id → the server sends no reply). */
  private notify(method: string, params?: unknown): void {
    const payload = params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    this.transport.send(`${JSON.stringify(payload)}\n`);
  }

  /** Buffer inbound bytes and dispatch each complete NDJSON line. */
  private onChunk(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.dispatch(line);
      nl = this.buf.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // not JSON (e.g. a stray log line) — ignore, never crash the client
    }
    if (typeof msg.id !== "number") return; // a notification or an unkeyed error — nothing to settle
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`));
    else entry.resolve(msg.result);
  }

  private onTransportClose(info: { code: number | null; signal: string | null; stderr?: string }): void {
    this.closed = true;
    this.closeInfo = info;
    const detail = info.stderr ? `\n--- server stderr ---\n${info.stderr.trim()}` : "";
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP server exited (code=${info.code}, signal=${info.signal}) with requests pending${detail}`));
    }
    this.pending.clear();
  }

  /** How the server process exited, if it has. Useful for diagnostics after `close()`. */
  get exitInfo(): { code: number | null; signal: string | null; stderr?: string } | null {
    return this.closeInfo;
  }
}

/** Raised when a tool call comes back as an MCP `isError` result (the protocol's tool-error channel). */
export class McpToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(`tool '${tool}' failed: ${message}`);
    this.name = "McpToolError";
  }
}

// ── child-process transport (the real cross-process stdio round trip) ───────────

/** A transport backed by a spawned child process, talking over its stdin/stdout (NDJSON). */
export class ChildProcessTransport implements McpTransport {
  private stderrTail = "";

  constructor(private readonly child: ChildProcess) {
    // Drain stderr if it is piped (keeps a small tail for error reporting; an unread pipe can stall
    // a chatty child). When stderr is inherited, child.stderr is null and this is a no-op.
    const err = child.stderr;
    if (err) {
      err.setEncoding("utf8");
      err.on("data", (d: string) => {
        this.stderrTail = (this.stderrTail + d).slice(-4096);
      });
    }
  }

  send(raw: string): void {
    this.child.stdin?.write(raw);
  }

  onMessage(cb: (chunk: string) => void): void {
    const out = this.child.stdout;
    if (!out) throw new Error("child process has no stdout pipe (stdio[1] must be 'pipe')");
    out.setEncoding("utf8");
    out.on("data", (d: string) => cb(d));
  }

  onClose(cb: (info: { code: number | null; signal: string | null; stderr?: string }) => void): void {
    this.child.on("exit", (code, signal) => cb({ code, signal, stderr: this.stderrTail || undefined }));
    this.child.on("error", () => cb({ code: null, signal: null, stderr: this.stderrTail || undefined }));
  }

  close(): void {
    this.child.stdin?.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }
}

export interface SpawnServerOptions {
  /** Back the server's recovery world with a real FsWorld rooted here (sets TOFFOLI_MCP_FS_ROOT). */
  fsRoot?: string;
  /** Extra env merged over the inherited process.env (e.g. TOFFOLI_EXECUTE_DISABLED to test the gate). */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the child. Default: the repo root inferred from this module. */
  cwd?: string;
  /**
   * Where the child's stderr goes. "inherit" (default) surfaces the server's readiness line to this
   * process; "pipe" captures a tail for error diagnostics (used by tests to keep output quiet).
   */
  stderr?: "inherit" | "pipe";
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repo root (lib/mcp → ../../). */
const REPO_ROOT = join(HERE, "..", "..");
const SERVER_SCRIPT = join(HERE, "server.ts");

/**
 * Spawn the real Toffoli MCP server (lib/mcp/server.ts) as a child process and return a transport to
 * it. The server is run through the repo's own `tsx` runtime — the exact thing `npm run mcp` does —
 * so this is a genuine cross-process client → server channel, not an in-process shim.
 */
export function spawnToffoliServer(opts: SpawnServerOptions = {}): ChildProcessTransport {
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  if (opts.fsRoot) env["TOFFOLI_MCP_FS_ROOT"] = opts.fsRoot;
  const child = spawn(process.execPath, [tsxCli, SERVER_SCRIPT], {
    cwd: opts.cwd ?? REPO_ROOT,
    env,
    stdio: ["pipe", "pipe", opts.stderr ?? "inherit"],
  });
  return new ChildProcessTransport(child);
}
