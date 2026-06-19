/** Toffoli — the undo layer for AI agents. */

export * from "./engine/index";
export * as ledger from "./adapters/ledger";

// The self-healing agent loop, the MCP server surface, and the real-DB recovery world.
// Namespaced so they add to the public surface without colliding with the engine exports.
export * as agent from "./agent/index";
export * as mcp from "./mcp/server";

// Reversibility-gated speculative execution: fire optimistically what the floor proves recoverable,
// roll back a rejected guess, and provably never speculate the irreversible class. Namespaced.
export * as speculative from "./runtime/speculative-gate";
export {
  SqlWorld,
  sqlRunInverse,
  sqlWorldSelfCheck,
  renderSelfCheck as renderSqlWorldSelfCheck,
  type SelfCheckResult,
} from "./exec/sql-world";
