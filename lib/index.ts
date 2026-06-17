/** Toffoli — the undo layer for AI agents. */

export * from "./engine/index";
export * as ledger from "./adapters/ledger";

// The self-healing agent loop, the MCP server surface, and the real-DB recovery world.
// Namespaced so they add to the public surface without colliding with the engine exports.
export * as agent from "./agent/index";
export * as mcp from "./mcp/server";
export {
  SqlWorld,
  sqlRunInverse,
  sqlWorldSelfCheck,
  renderSelfCheck as renderSqlWorldSelfCheck,
  type SelfCheckResult,
} from "./exec/sql-world";
