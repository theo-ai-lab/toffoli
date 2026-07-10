import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // The denominator is the whole engine surface, not just the files a test happens
      // to import — a new untested module lowers the number instead of hiding from it.
      include: ["lib/**/*.ts"],
      exclude: ["lib/**/*.test.ts"],
      reporter: ["text-summary", "json-summary"],
      // Floors at the measured baseline on this whole-lib basis (node 24, 2026-07-10:
      // statements 76.04, branches 69.35, functions 78.44, lines 77.51), rounded down
      // to whole percents so v8 fraction jitter across the CI Node matrix (22 and 24)
      // cannot flake the gate. Raise them as tests grow; never lower silently.
      thresholds: {
        statements: 76,
        branches: 69,
        functions: 78,
        lines: 77,
      },
    },
  },
});
