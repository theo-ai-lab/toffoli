/**
 * Toffoli — the tool surface a self-healing agent calls, and the dispatcher that runs each
 * call against a sandboxed world.
 *
 * Two halves, kept together so they can't drift:
 *   1. TOOL DEFINITIONS (`ToolDef[]`) — the `input_schema`'d functions the model is allowed to
 *      call. These are handed to the model exactly as the judge hands it a JSON schema; the only
 *      difference is the loop dispatches on `stop_reason === "tool_use"` instead of reading one
 *      structured output (see judge.ts for the shared client/fencing discipline).
 *   2. TOOL IMPLEMENTATIONS (`ToolRegistry`) — each runs the REAL mutation against the world and
 *      RETURNS the `AgentAction` it performed (the World/FsWorld convention), so the run log fed to
 *      the classifier is generated from genuine operations, never hand-authored narration.
 *
 * One tool — `delete_rows` — is DELIBERATELY damage-prone: it soft-deletes every id it is handed,
 * and if any of them are NOT test rows it flags `damaged` so the loop fires the recovery pipeline.
 * This is the injected-fault surface: an over-broad bulk delete is exactly the agent mistake the
 * undo layer exists to catch (the canonical "the agent deleted prod" failure, scoped to a sandbox).
 *
 * The world is referenced through a STRUCTURAL `AgentWorld` interface (the four `RecoveryWorld`
 * inverses plus the convention mutators this domain uses), so the in-memory `World` satisfies it
 * today and a SQL-backed adapter that follows the same return-the-AgentAction convention drops in
 * unchanged.
 *
 * Zero dependencies.
 */

import type { AgentAction } from "../engine/types";
import type { RecoveryWorld } from "../exec/world";

/**
 * The world a tool acts on: the four idempotent inverses the recovery pipeline needs
 * (`RecoveryWorld`) plus the convention mutators this reconcile-rows domain uses. Every mutator
 * returns the `AgentAction` it performed, with HONEST recovery signals on `target`
 * (`recoverable` / `externalized`) — that is what makes the deterministic classifier exact.
 */
export interface AgentWorld extends RecoveryWorld {
  /** Soft-delete a row into a recoverable trash (→ REVERSIBLE: restored from trash). */
  softDeleteRow(table: string, id: string): AgentAction;
  /** A refundable charge against your own ledger (→ COMPENSABLE: offset by a refund). */
  charge(merchant: string, amountUsd: number): AgentAction;
  /** An external send (→ IRREVERSIBLE: there is no un-send — escalated to a human). */
  sendEmail(to: string, body: string): AgentAction;
}

/** An Anthropic-shaped tool definition: name + description + JSON `input_schema`. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/** What running one tool produced: the genuine actions, the text the model sees back, and signals. */
export interface ToolExecResult {
  /** The real mutations performed, as AgentActions — appended to the run log for classification. */
  actions: AgentAction[];
  /** The `tool_result` content returned to the model. */
  output: string;
  /** True iff this call damaged live state — the loop fires the recovery pipeline when set. */
  damaged?: boolean;
  /** True iff the call itself failed (unknown tool, bad args) — also triggers a recovery sweep. */
  isError?: boolean;
  /** True iff the agent declared the task complete (the `finish` tool). */
  finished?: boolean;
}

export type ToolImpl = (input: Record<string, unknown>, world: AgentWorld) => ToolExecResult;
export type ToolRegistry = Record<string, ToolImpl>;

/** A bundle of definitions (for the model) and implementations (for the dispatcher), kept in sync. */
export interface ToolSet {
  defs: ToolDef[];
  registry: ToolRegistry;
}

// ── small readers over the loosely-typed input bag ──────────────────────────────

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

/** Read the live rows of one logical table out of the world snapshot, keyed by bare id. */
function rowsInTable(world: AgentWorld, table: string): Record<string, unknown> {
  const prefix = `${table}:`;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(world.snapshot().rows)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
  }
  return out;
}

function isTestRow(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>)["is_test"] === true);
}

// ── the reconcile-rows tool set ─────────────────────────────────────────────────

/**
 * The tools for the canonical goal: clean the test/sandbox rows out of a table before a period
 * close, optionally call a paid enrichment API, and email a summary — the mix that exercises all
 * three recovery classes (REVERSIBLE restore, COMPENSABLE refund, IRREVERSIBLE escalate).
 */
export function reconcileToolSet(): ToolSet {
  const defs: ToolDef[] = [
    {
      name: "list_rows",
      description: "List the live rows of a table (read-only; observes state, changes nothing). Use this to see which rows are test/sandbox (is_test = true) before deleting anything.",
      input_schema: {
        type: "object",
        properties: { table: { type: "string", description: "the table to list, e.g. 'orders'" } },
        required: ["table"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_rows",
      description: "Soft-delete the listed rows from a table (recoverable from trash). Pass ONLY the ids you were asked to remove. Deleting rows that are not test rows damages live data.",
      input_schema: {
        type: "object",
        properties: {
          table: { type: "string", description: "the table to delete from" },
          ids: { type: "array", items: { type: "string" }, description: "the row ids to soft-delete" },
        },
        required: ["table", "ids"],
        additionalProperties: false,
      },
    },
    {
      name: "charge_fee",
      description: "Charge a small processing/enrichment fee to your own ledger. Refundable while it has not settled (COMPENSABLE).",
      input_schema: {
        type: "object",
        properties: {
          merchant: { type: "string", description: "the service charged, e.g. 'enrich-api'" },
          amountUsd: { type: "number", description: "the fee amount in USD" },
        },
        required: ["merchant", "amountUsd"],
        additionalProperties: false,
      },
    },
    {
      name: "email_summary",
      description: "Email a one-line summary to a recipient. This leaves your system — an external send cannot be un-sent (IRREVERSIBLE).",
      input_schema: {
        type: "object",
        properties: {
          to: { type: "string", description: "the recipient address" },
          body: { type: "string", description: "the summary body" },
        },
        required: ["to", "body"],
        additionalProperties: false,
      },
    },
    {
      name: "finish",
      description: "Declare the task complete. Call this only when the goal is genuinely met (test rows gone, live rows intact).",
      input_schema: {
        type: "object",
        properties: { summary: { type: "string", description: "a one-line summary of the outcome" } },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  ];

  const registry: ToolRegistry = {
    list_rows: (input, world) => {
      const table = str(input["table"], "orders");
      const rows = rowsInTable(world, table);
      const view = Object.entries(rows).map(([id, v]) => ({ id, ...(v as Record<string, unknown>) }));
      return { actions: [], output: `Rows in '${table}' (${view.length}): ${JSON.stringify(view)}` };
    },

    // DELIBERATELY damage-prone: it deletes whatever it is handed. The fault surfaces when the
    // model hands it ids that are not test rows (an over-broad bulk delete).
    delete_rows: (input, world) => {
      const table = str(input["table"], "orders");
      const requested = ids(input["ids"]);
      const present = rowsInTable(world, table);
      const actions: AgentAction[] = [];
      const skipped: string[] = [];
      const damagedIds: string[] = [];
      for (const id of requested) {
        if (!(id in present)) {
          skipped.push(id); // nothing to delete — keep the run log honest (no phantom action)
          continue;
        }
        if (!isTestRow(present[id])) damagedIds.push(id);
        actions.push(world.softDeleteRow(table, id));
      }
      const damaged = damagedIds.length > 0;
      const parts = [`Soft-deleted ${actions.length} row(s) from '${table}'.`];
      if (skipped.length) parts.push(`(${skipped.length} id(s) not present, skipped: ${skipped.join(", ")}.)`);
      if (damaged) {
        parts.push(`WARNING: ${damagedIds.length} of them were NOT test rows (ids ${damagedIds.join(", ")}) — this over-broad delete damaged live data.`);
      }
      return { actions, output: parts.join(" "), damaged };
    },

    charge_fee: (input, world) => {
      const merchant = str(input["merchant"], "service");
      const amountUsd = num(input["amountUsd"]);
      const action = world.charge(merchant, amountUsd);
      return { actions: [action], output: `Charged $${amountUsd} to '${merchant}' (refundable until settled).` };
    },

    email_summary: (input, world) => {
      const to = str(input["to"]);
      const body = str(input["body"]);
      const action = world.sendEmail(to, body);
      return { actions: [action], output: `Sent email to ${to}. (External send — cannot be un-sent.)` };
    },

    finish: (input) => {
      const summary = str(input["summary"], "done");
      return { actions: [], output: `Task marked complete: ${summary}`, finished: true };
    },
  };

  return { defs, registry };
}

/**
 * Dispatch one tool call to its implementation. An unknown tool or a thrown implementation is an
 * HONEST error (`isError: true`) — never a silent success — and the loop treats it as a trigger to
 * sweep the run for damage, the same as a tool that flagged it.
 */
export function executeTool(tools: ToolSet, name: string, input: Record<string, unknown>, world: AgentWorld): ToolExecResult {
  const impl = tools.registry[name];
  if (!impl) {
    return { actions: [], output: `error: unknown tool '${name}'`, isError: true };
  }
  try {
    return impl(input, world);
  } catch (err) {
    return { actions: [], output: `error: tool '${name}' threw — ${(err as Error).message}`, isError: true };
  }
}
