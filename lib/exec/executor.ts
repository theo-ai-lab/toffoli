/**
 * Toffoli — the reference executor.
 *
 * Takes a dependency-ordered ResumablePlan and a sandboxed World, and actually RUNS each
 * compensation, dispatching its `method` to the matching inverse operation. It is a resumable saga:
 * each step is idempotent, and on failure it records the resume point and blocks the remaining
 * steps (a saga never charges ahead past a failed compensation). Methods the minimal world doesn't
 * model are reported `unsupported` — honestly, never silently "restored".
 *
 * Zero dependencies.
 */

import type { ResumablePlan } from "../engine/resumable";
import type { RecoveryWorld } from "./world";

export type StepStatus = "restored" | "failed" | "unsupported" | "blocked";

export interface StepResult {
  index: number;
  forActionId: string;
  method: string;
  status: StepStatus;
  detail: string;
}

export interface RecoveryResult {
  steps: StepResult[];
  restored: number;
  failed: number;
  unsupported: number;
  blocked: number;
  /** Index of the first failed step (the resume point), or null if no failure. */
  resumeFrom: number | null;
  /** Count of irreversible/dominated actions escalated to a human (never auto-executed). */
  escalated: number;
}

export interface ExecuteOptions {
  /** Stop and block remaining steps on the first failure (default true — saga discipline). */
  stopOnFailure?: boolean;
  /** Inject a forced failure on a given action id, for partial-failure testing. */
  failOn?: string;
}

export function execute(plan: ResumablePlan, world: RecoveryWorld, opts: ExecuteOptions = {}): RecoveryResult {
  const stopOnFailure = opts.stopOnFailure ?? true;
  const steps: StepResult[] = [];
  let resumeFrom: number | null = null;
  let blocked = false;

  for (const step of plan.steps) {
    if (blocked) {
      steps.push({ index: step.index, forActionId: step.forActionId, method: step.compensation.method, status: "blocked", detail: "blocked by an earlier failed compensation" });
      continue;
    }
    const res = runOne(step, world, opts);
    steps.push(res);
    if (res.status === "failed") {
      if (resumeFrom === null) resumeFrom = step.index;
      if (stopOnFailure) blocked = true;
    }
  }

  return {
    steps,
    restored: steps.filter((s) => s.status === "restored").length,
    failed: steps.filter((s) => s.status === "failed").length,
    unsupported: steps.filter((s) => s.status === "unsupported").length,
    blocked: steps.filter((s) => s.status === "blocked").length,
    resumeFrom,
    escalated: plan.escalations.length,
  };
}

/** The outcome of dispatching one inverse to the world — shared by the plain and safe executors. */
export interface InverseOutcome {
  status: "restored" | "failed" | "unsupported";
  detail: string;
  /**
   * When `status` is "failed" because the world inverse THREW, the raw error. The runtime executor
   * uses it to classify transience (so a transient backend fault is retried, not treated as permanent).
   * Absent for a non-throwing "no-op / not found" failure, which is permanent by construction.
   */
  error?: unknown;
}

/**
 * Dispatch one compensation `method` to the matching world inverse, applying the idempotency key.
 * Pure routing — no saga/blocking/journal logic — so both `execute` (plain) and the safe runtime
 * executor share exactly one mapping from method → world inverse. A method the world doesn't model
 * is `unsupported` (honest), never silently "restored".
 */
export function dispatchInverse(method: string, params: Record<string, unknown> | undefined, idem: string, world: RecoveryWorld): InverseOutcome {
  const id = typeof params?.["id"] === "string" ? (params["id"] as string) : undefined;
  const kind = typeof params?.["kind"] === "string" ? (params["kind"] as string) : undefined;
  try {
    switch (method) {
      case "delete":
        if (kind === "file" && id) return settle(world.deleteFile(id, idem), `deleted ${id}`);
        return unsup(`delete on '${kind}'`);
      case "restore":
        if (id) return settle(world.restoreRow(id, idem), `restored ${id}`);
        return unsup("restore without id");
      case "refund": {
        const amt = typeof params?.["amountUsd"] === "number" ? (params["amountUsd"] as number) : 0;
        return settle(world.refund(amt, idem), `refunded $${amt}`);
      }
      default:
        return unsup(`no world adapter for '${method}'`);
    }
  } catch (err) {
    return { status: "failed", detail: (err as Error).message, error: err };
  }
}

function settle(ok: boolean, detail: string): InverseOutcome {
  return ok ? { status: "restored", detail } : { status: "failed", detail: `${detail} (no-op / not found)` };
}
function unsup(why: string): InverseOutcome {
  return { status: "unsupported", detail: `${why} — would need a real system adapter` };
}

function runOne(
  step: ResumablePlan["steps"][number],
  world: RecoveryWorld,
  opts: ExecuteOptions,
): StepResult {
  const { method, params, idempotencyKey: idem } = step.compensation;
  const base = { index: step.index, forActionId: step.forActionId, method };
  if (opts.failOn === step.forActionId) {
    return { ...base, status: "failed", detail: "injected failure" };
  }
  const { status, detail } = dispatchInverse(method, params, idem, world);
  return { ...base, status, detail };
}
