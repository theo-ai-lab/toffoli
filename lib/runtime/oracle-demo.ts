/**
 * Toffoli — the PERMISSION ORACLE demo. `npm run oracle:demo`.
 *
 * Replays a tool-using agent's intended actions through the reversibility-bounded pre-act authorizer
 * two ways, so the safety-floor-backed permission decision is visible end-to-end:
 *   1. NORMAL      — each action is authorized PROCEED (reversible/compensable) or ESCALATE
 *                    (irreversible / the floor abstained). This is the human "are you sure?" prompt,
 *                    replaced by a deterministic, journaled decision.
 *   2. KILL-SWITCH — the same actions under TOFFOLI_EXECUTE_DISABLED=1: every MUTATING action is
 *                    forced to ESCALATE; only the nullipotent read still proceeds.
 *
 * Deterministic and offline (no key, no network). Mutates nothing — it only DECIDES.
 */

import { PermissionOracle, type AuthorizationDecision } from "./permission-oracle";
import { InMemorySink } from "./escalation";
import { KILL_SWITCH_ENV } from "./mode";
import type { AgentAction } from "../engine/types";

const clock = () => "2026-06-14T00:00:00Z";

/** A realistic mixed run: a read, a recoverable delete, a refundable charge, a hard delete, an external send. */
function intendedActions(): AgentAction[] {
  return [
    { id: "list", tool: "db.query", params: { sql: "SELECT * FROM orders" } },
    { id: "soft-del", tool: "db.execute", op: "delete", target: { kind: "db.row", id: "orders:42", recoverable: true } },
    { id: "fee", tool: "stripe.charge", op: "pay", params: { amountUsd: 5 }, target: { kind: "payment", externalized: false } },
    { id: "hard-del", tool: "db.execute", params: { sql: "DROP TABLE staging_audit" } },
    { id: "email", tool: "email.send", op: "send", target: { kind: "email", externalized: true } },
    { id: "patch", tool: "db.execute", op: "update", target: { kind: "db.row", id: "orders:7" } }, // floor abstains → fail-closed
  ];
}

function row(d: AuthorizationDecision): string {
  const mark = d.verdict === "PROCEED" ? "✓ PROCEED " : "⚠ ESCALATE";
  const tag = d.failClosed ? " [fail-closed]" : "";
  return `    ${mark}  ${d.actionId.padEnd(9)} ${String(d.class).padEnd(13)} confirmed=${d.journalConfirmed}${tag}  ${d.reason}`;
}

function run(title: string, env: NodeJS.ProcessEnv): void {
  const sink = new InMemorySink();
  const oracle = new PermissionOracle({ env, clock, sink, runId: "demo", caller: "reconcile-agent" });
  console.log(`  ${"=".repeat(78)}`);
  console.log(`  ${title}`);
  console.log(`  ${"=".repeat(78)}`);
  for (const action of intendedActions()) console.log(row(oracle.authorize(action)));
  const proceeded = oracle.proceeded().length;
  const escalated = oracle.escalated().length;
  console.log(`  ${"-".repeat(78)}`);
  console.log(`  decisions: ${proceeded} PROCEED · ${escalated} ESCALATE (deferred to a human)`);
  console.log(`  journal: ${oracle.journal.entries().length} durable decision record(s); anti-fabrication audit: ${oracle.authorizationAudit().pass ? "PASS" : "FAIL"}`);
  console.log(`  oversight sink: ${sink.depth()} escalation(s) delivered for human authorization`);
  console.log();
}

run("1 · NORMAL — the pre-act permission prompt, replaced by a journaled reversibility decision", {} as NodeJS.ProcessEnv);
run("2 · KILL-SWITCH (TOFFOLI_EXECUTE_DISABLED=1) — every mutating action is frozen to ESCALATE", { [KILL_SWITCH_ENV]: "1" } as NodeJS.ProcessEnv);
