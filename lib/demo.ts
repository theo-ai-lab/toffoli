/**
 * Toffoli — a zero-setup demo. `npm run demo`.
 *
 * Feeds a realistic agent run through the engine and prints the restitution receipt to the
 * terminal. Runs deterministic-only unless ANTHROPIC_API_KEY is set (then the judge handles the
 * residual). Nothing is executed — Toffoli plans the restitution.
 *
 * `run` and `renderReceipt` are exported and pure, so the receipt is snapshot-testable and the
 * README banner can quote it verbatim (no drift).
 */

import { restitute, isJudgeAvailable, claudeJudge } from "./engine/index";
import type { ActionLog, RestitutionPlan } from "./engine/index";

// An agent asked to "tidy up the staging database and email me a summary" — and the mix of things
// it actually did, newest-effects-last. `effect` is the human-readable description (what a real
// log/trace would carry); it doesn't affect deterministic classification.
export const run: ActionLog = [
  { id: "a1", tool: "db.query", params: { method: "GET", sql: "SELECT count(*) FROM orders" }, effect: "read order counts", at: "2026-06-05T09:00:00Z" },
  { id: "a2", tool: "fs.write", op: "create", target: { kind: "file", id: "/backups/orders.bak" }, effect: "created /backups/orders.bak", at: "2026-06-05T09:01:00Z" },
  { id: "a3", tool: "db.execute", params: { sql: "DELETE FROM orders WHERE is_test = true" }, target: { kind: "db.row", recoverable: true }, effect: "soft-deleted test orders", at: "2026-06-05T09:02:00Z" },
  { id: "a4", tool: "stripe.charge", op: "pay", params: { amountUsd: 12 }, target: { kind: "payment", id: "enrich-api", externalized: false }, effect: "charged the enrichment API $12", at: "2026-06-05T09:03:00Z" },
  { id: "a5", tool: "db.execute", params: { sql: "DROP TABLE orders_archive" }, effect: "dropped table orders_archive", at: "2026-06-05T09:04:00Z" },
  { id: "a6", tool: "email.send", op: "send", target: { kind: "email", externalized: true }, effect: "emailed the summary to client@acme.com", at: "2026-06-05T09:05:00Z" },
];

const GLYPH: Record<string, string> = { NULLIPOTENT: "·", REVERSIBLE: "‹", COMPENSABLE: "~", IRREVERSIBLE: "!" };
const LABEL: Record<string, string> = { NULLIPOTENT: "no effect", REVERSIBLE: "RESTORED", COMPENSABLE: "COMPENSATED", IRREVERSIBLE: "REQUIRES HUMAN" };

/** Render the restitution receipt as a string (pure — no I/O). Pass the run for readable rows. */
export function renderReceipt(plan: RestitutionPlan, actions: ActionLog = []): string {
  const w = 76;
  const rule = (ch = "─") => ch.repeat(w);
  const out: string[] = [];
  const line = (s = "") => out.push(`  ${s}`);
  const descById = new Map(actions.map((a) => [a.id, a.effect ?? a.tool]));

  line(rule("="));
  line("TOFFOLI — RESTITUTION RECEIPT".padStart(Math.floor((w + 30) / 2)));
  line("the undo layer for AI agents".padStart(Math.floor((w + 28) / 2)));
  line(rule());
  line("    action                              class            restitution");
  line(rule("·"));

  const compById = new Map(plan.compensations.map((c) => [c.forActionId, c]));
  for (const c of plan.classifications) {
    const g = GLYPH[c.class] ?? "?";
    const comp = compById.get(c.actionId);
    const restitution =
      c.class === "NULLIPOTENT" ? "—" : c.class === "IRREVERSIBLE" ? "escalated ↑" : `${comp?.method ?? "?"} (${comp?.restoration ?? "?"})`;
    const desc = truncate(descById.get(c.actionId) ?? c.actionId, 32);
    line(`${g}  ${c.actionId.padEnd(3)} ${desc.padEnd(33)} ${(LABEL[c.class] ?? c.class).padEnd(15)}  ${restitution}`);
  }
  line(rule());

  const s = plan.summary;
  line(`SUMMARY   ${s.total} actions  ·  ${s.noEffect} no-effect  ·  ${s.restored} restored  ·  ${s.compensated} compensated  ·  ${s.irreversible} escalated`);
  line(`PIVOT     ${s.pivotActionId ? `${s.pivotActionId} — point of no return (everything after is retriable, not undoable)` : "none — the run is fully recoverable"}`);
  line(`VERDICT   ${s.fullyRecoverable ? "the world can be put back automatically" : "a human must decide on the irreversible remainder"}`);

  if (plan.escalations.length) {
    line(rule("·"));
    line("REQUIRES HUMAN");
    for (const e of plan.escalations) {
      const desc = descById.get(e.forActionId);
      line(`  [${e.severity}] ${e.forActionId}${desc ? ` (${desc})` : ""}: ${e.decision}`);
      line(`         why: ${e.reason}`);
    }
  }
  line(rule("="));
  return out.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

async function main(): Promise<void> {
  const judge = isJudgeAvailable() ? claudeJudge() : undefined;
  if (!judge) console.log("\n  (running deterministic-only — set ANTHROPIC_API_KEY to enable the judge on the residual)");
  const plan = await restitute(run, { judge });
  console.log(renderReceipt(plan, run));
}

// Run only as a script, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
