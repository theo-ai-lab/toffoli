/**
 * Toffoli — the fixed, reproducible scenario the speculative gate is measured over.
 *
 * A worked example spanning every class so the cascade-telemetry slice is genuine, not asserted: five
 * recoverable test-row deletes and two small charges that SPECULATE-AND-COMMIT, one over-cap charge
 * that SPECULATES-THEN-ROLLS-BACK (the policy rejects it on a dimension the reversibility floor can't
 * see), two external sends that are IRREVERSIBLE and so are NEVER speculated (escalated, fail-closed),
 * and two reads that run directly. Every number the demo/README report is computed by really running
 * these twelve actions through the gate on the sandbox world.
 *
 * This is a SYNTHETIC fixture (provenance: engine dev) — the percentages reflect the scenario's mix,
 * NOT any real-world prevalence. `buildSpeculativeScenario()` returns a FRESH world + ops each call
 * (the gate mutates the world), so it can be swept by the curve on an identical starting state.
 *
 * Zero dependencies.
 */

import type { AgentAction } from "../engine/types";
import { World } from "../exec/world";
import { spendCapPolicy, type SpeculativeOp } from "./speculative-gate";

/** The orthogonal spend cap (USD) the authoritative policy enforces — independent of reversibility. */
export const SPEND_CAP = 100;

/** The orthogonal authorization policy the scenario's authoritative tier composes in. */
export const scenarioPolicy = spendCapPolicy(SPEND_CAP);

/** A speculatable soft-delete of a recoverable test row (→ REVERSIBLE). */
function deleteOp(id: string): SpeculativeOp<World> {
  return {
    action: { id: `del-${id}`, tool: "db.execute", op: "delete", params: { sql: `DELETE FROM orders WHERE id = '${id}'` }, target: { kind: "db.row", id: `orders:${id}`, recoverable: true } },
    fire: (world) => world.softDeleteRow("orders", id),
  };
}

/** A speculatable, refundable charge (→ COMPENSABLE). Over the cap the policy rejects it → rollback. */
function chargeOp(merchant: string, amountUsd: number): SpeculativeOp<World> {
  return {
    action: { id: `charge-${merchant}`, tool: "stripe.charge", op: "pay", params: { amountUsd }, target: { kind: "payment", id: merchant, externalized: false } },
    fire: (world) => world.charge(merchant, amountUsd),
  };
}

/** An external send (→ IRREVERSIBLE). Provably never speculated; escalated to a human. */
function sendOp(to: string): SpeculativeOp<World> {
  const action: AgentAction = { id: `email-${to}`, tool: "email.send", op: "send", target: { kind: "email", externalized: true } };
  return { action, fire: (world) => world.sendEmail(to, "period-close summary") };
}

/** A read (→ NULLIPOTENT). Runs directly; no speculation, no rollback risk. */
function readOp(id: string, table: string): SpeculativeOp<World> {
  const action: AgentAction = { id, tool: "db.query", op: "read", params: { sql: `SELECT * FROM ${table}` } };
  return {
    action,
    fire: (world) => {
      world.snapshot(); // a genuine read; mutates nothing
      return action;
    },
  };
}

export interface SpeculativeScenario {
  world: World;
  ops: SpeculativeOp<World>[];
}

/** Build a fresh world (seeded with five recoverable test rows) and the twelve candidate actions. */
export function buildSpeculativeScenario(): SpeculativeScenario {
  const world = new World();
  for (const id of ["t1", "t2", "t3", "t4", "t5"]) world.seedRow("orders", id, { is_test: true });

  const ops: SpeculativeOp<World>[] = [
    deleteOp("t1"),
    deleteOp("t2"),
    deleteOp("t3"),
    deleteOp("t4"),
    deleteOp("t5"),
    chargeOp("enrich-api", 20), // under cap → commit
    chargeOp("report-api", 40), // under cap → commit
    chargeOp("bulk-vendor", 500), // OVER cap → policy reject → rollback
    sendOp("client@acme.com"), // IRREVERSIBLE → escalate
    sendOp("ops@acme.com"), // IRREVERSIBLE → escalate
    readOp("list-orders", "orders"), // NULLIPOTENT → run directly
    readOp("list-payments", "payments"), // NULLIPOTENT → run directly
  ];
  return { world, ops };
}
