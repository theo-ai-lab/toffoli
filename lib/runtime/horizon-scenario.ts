/**
 * Toffoli — the fixed planning domain the receding-horizon controller is demonstrated and measured on.
 *
 * The task: SAFELY CLOSE A BILLING PERIOD on the sandbox world. Two sub-goals:
 *   1. every stale `orders` row is cleared, and
 *   2. a period backup exists.
 *
 * Each sub-goal has competing routes that the deterministic-first planner must choose between — which
 * is the whole point of the demonstration:
 *
 *   · clearing a stale row:  REVERSIBLE soft-delete (recoverable trash)  vs.  the IRREVERSIBLE
 *     one-shot `DROP TABLE orders` that clears every row at once (no recoverable copy). The drop is the
 *     tempting shortcut — fewest steps, biggest one-step progress — and STAGE 1 prunes every plan that
 *     contains it for FREE, before the objective ever scores it.
 *   · taking the backup:     REVERSIBLE local snapshot file (cheap, exact undo) vs. a COMPENSABLE
 *     managed-vendor charge (money moved, semantic-only undo). Both are feasible; STAGE 2's deterministic
 *     blast/irreversibility cost prefers the reversible local snapshot.
 *
 * The state projection is CONSISTENT with the world's real mutations (model == reality, by
 * construction): a soft-delete removes one row key; dropping the `orders` table orphans ALL its rows
 * (so none are "live"); writing the backup file or posting the vendor charge each satisfy the backup
 * sub-goal. The only thing the model does NOT see is an injected ENVIRONMENT DISTURBANCE (a new stale
 * row arriving mid-episode) — used to exercise the receding-horizon adaptation.
 *
 * This is a SYNTHETIC demonstration fixture (provenance: engine dev). Every number a demo/test reports
 * is computed by really running this domain through the planner; none is a real-world prevalence claim.
 *
 * Zero dependencies.
 */

import { World, type WorldState } from "../exec/world";
import type { CandidateAction, PlanningDomain } from "./horizon-planner";

/** The managed-backup vendor fee (USD) — the blast radius of the COMPENSABLE backup route. */
export const BACKUP_FEE = 5;
/** The backup snapshot file the REVERSIBLE route writes. */
export const BACKUP_FILE = "period-backup.txt";
/** The table whose stale rows must be cleared. */
export const ORDERS_TABLE = "orders";

/** The controller's belief about the billing-close world: which stale rows are still live, and whether a backup exists. */
export interface CloseState {
  /** Stale `orders` row ids still live (table present AND row present). */
  live: ReadonlySet<string>;
  /** True iff a period backup exists (local snapshot file OR a posted managed-vendor charge). */
  backupReady: boolean;
}

type CloseAction = CandidateAction<World, CloseState>;

function without(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  next.delete(id);
  return next;
}

/** REVERSIBLE — soft-delete one stale row to recoverable trash. */
function softDeleteOp(id: string): CloseAction {
  return {
    label: `soft-delete orders:${id} (reversible)`,
    action: { id: `del-${id}`, tool: "db.execute", op: "delete", params: { sql: `DELETE FROM ${ORDERS_TABLE} WHERE id = '${id}'` }, target: { kind: "db.row", id: `${ORDERS_TABLE}:${id}`, recoverable: true } },
    fire: (w) => w.softDeleteRow(ORDERS_TABLE, id),
    predict: (s) => ({ ...s, live: without(s.live, id) }),
  };
}

/** IRREVERSIBLE — drop the whole table: clears every stale row in ONE step, with no recoverable copy. The shortcut stage-1 prunes. */
function dropAllOp(): CloseAction {
  return {
    label: `DROP TABLE ${ORDERS_TABLE} (IRREVERSIBLE one-shot shortcut)`,
    action: { id: "drop-orders", tool: "db.execute", params: { sql: `DROP TABLE ${ORDERS_TABLE}` }, target: { kind: "table", id: ORDERS_TABLE } },
    fire: (w) => w.dropTable(ORDERS_TABLE),
    predict: (s) => ({ ...s, live: new Set<string>() }),
  };
}

/** REVERSIBLE — write a local backup snapshot file (exact undo: delete the file). */
function writeBackupOp(): CloseAction {
  return {
    label: `write ${BACKUP_FILE} (reversible local snapshot)`,
    action: { id: "backup-file", tool: "fs.write", op: "create", target: { kind: "file", id: BACKUP_FILE } },
    fire: (w) => w.writeFile(BACKUP_FILE, "period-close snapshot"),
    predict: (s) => ({ ...s, backupReady: true }),
  };
}

/** COMPENSABLE — pay a managed backup vendor (semantic undo: a refund; money still moved). */
function payBackupOp(): CloseAction {
  return {
    label: `charge backup-vendor $${BACKUP_FEE} (compensable managed backup)`,
    action: { id: "backup-vendor", tool: "stripe.charge", op: "pay", params: { amountUsd: BACKUP_FEE }, target: { kind: "payment", id: "backup-vendor", externalized: false } },
    fire: (w) => w.charge("backup-vendor", BACKUP_FEE),
    predict: (s) => ({ ...s, backupReady: true }),
  };
}

/** Project the true world snapshot into the planning state (model == reality, by construction). */
export function observeClose(snapshot: WorldState): CloseState {
  const tableLive = snapshot.tables.includes(ORDERS_TABLE);
  const live = new Set<string>();
  if (tableLive) {
    for (const key of Object.keys(snapshot.rows)) if (key.startsWith(`${ORDERS_TABLE}:`)) live.add(key.slice(ORDERS_TABLE.length + 1));
  }
  const backupReady = Boolean(snapshot.files[BACKUP_FILE]) || snapshot.ledgerUsd > 0;
  return { live, backupReady };
}

/** The billing-close domain: observe, the action library, goal-distance, and (default) stage-2 cost. */
export const closeDomain: PlanningDomain<World, CloseState> = {
  observe: (world) => observeClose(world.snapshot()),
  distance: (s) => s.live.size + (s.backupReady ? 0 : 1),
  actions: (s) => {
    const acts: CloseAction[] = [];
    for (const id of [...s.live].sort()) acts.push(softDeleteOp(id));
    if (s.live.size > 0) acts.push(dropAllOp()); // the irreversible shortcut, offered while rows remain
    if (!s.backupReady) {
      acts.push(writeBackupOp());
      acts.push(payBackupOp());
    }
    return acts;
  },
};

export interface CloseScenario {
  world: World;
  domain: PlanningDomain<World, CloseState>;
}

/** A FRESH world seeded with `staleRows` stale `orders` rows, plus the close domain. */
export function buildCloseScenario(staleRows: string[] = ["t1", "t2", "t3"]): CloseScenario {
  const world = new World();
  world.seedTable(ORDERS_TABLE);
  for (const id of staleRows) world.seedRow(ORDERS_TABLE, id, { is_stale: true });
  return { world, domain: closeDomain };
}

/**
 * An ENVIRONMENT DISTURBANCE the planner's model cannot see: a new stale order row `arrivalId` lands
 * AFTER controller step `arriveAfterStep`. The receding-horizon loop re-observes the world each step,
 * so it discovers the late arrival and cleans it too — whereas an open-loop plan computed once would
 * stop short. Deterministic.
 */
export function lateArrival(arrivalId: string, arriveAfterStep = 0): (step: number, world: World) => void {
  let arrived = false;
  return (step, world) => {
    if (!arrived && step === arriveAfterStep) {
      world.seedRow(ORDERS_TABLE, arrivalId, { is_stale: true, late: true });
      arrived = true;
    }
  };
}
