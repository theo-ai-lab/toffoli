/**
 * Toffoli — the Recovery Explorer's scenario, as a real `ActionLog`.
 *
 * This is the eight-action run the live explorer page windows. It exists as data here — not as
 * hand-written HTML — so the page's per-action classes and restitution labels are COMPUTED by the
 * real engine at build time (`npm run design:build`, lib/design/build.ts) and locked by the
 * no-drift test (lib/design/build.test.ts). Every action is written so the deterministic floor
 * commits (no judge, no fail-safe): the signals (`priorState`, `recoverable`, `externalized`)
 * are the trusted-instrumentation inputs the classifier keys on.
 *
 * The story: an agent asked to "refresh the vendor pricing" reads state, stages artifacts, spends
 * money, then crosses the point of no return — an external email blast and a destructive DROP.
 */

import type { ActionLog } from "../engine/index";

export const explorerRun: ActionLog = [
  {
    id: "a1",
    tool: "db.query",
    params: { sql: "SELECT sku, qty FROM inventory" },
    effect: "read inventory",
    at: "2026-06-05T10:00:00Z",
  },
  {
    id: "a2",
    tool: "fs.write",
    op: "create",
    target: { kind: "file", id: "/exports/export.csv" },
    effect: "create export.csv",
    at: "2026-06-05T10:01:00Z",
  },
  {
    id: "a3",
    tool: "db.execute",
    op: "update",
    target: { kind: "db.row", id: "price:sku-112", priorState: { priceUsd: 18 } },
    effect: "update price (prior captured)",
    at: "2026-06-05T10:02:00Z",
  },
  {
    id: "a4",
    tool: "vendor.charge",
    op: "pay",
    params: { amountUsd: 40 },
    target: { kind: "payment", id: "vendor-api", externalized: false },
    effect: "charge vendor API $40",
    at: "2026-06-05T10:03:00Z",
  },
  {
    id: "a5",
    tool: "cms.publish",
    op: "publish",
    target: { kind: "cms.page", id: "pricing", externalized: false },
    effect: "publish price to internal CMS",
    at: "2026-06-05T10:04:00Z",
  },
  {
    id: "a6",
    tool: "email.send",
    op: "send",
    target: { kind: "email", externalized: true },
    effect: "email 5k customers",
    at: "2026-06-05T10:05:00Z",
  },
  {
    id: "a7",
    tool: "db.execute",
    params: { sql: "DROP TABLE staging_orders" },
    effect: "drop staging table",
    at: "2026-06-05T10:06:00Z",
  },
  {
    id: "a8",
    tool: "db.execute",
    op: "delete",
    target: { kind: "db.row", id: "logs:old", recoverable: true },
    effect: "soft-delete old logs",
    at: "2026-06-05T10:07:00Z",
  },
];
