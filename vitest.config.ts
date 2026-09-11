import { defineConfig } from "vitest/config";

/**
 * Worker test runner. Vitest for the same reason the dashboard uses it: no
 * transpile step for TypeScript ESM, and the same command in both repos.
 *
 * The worker's pure helpers need nothing but Node. `tests/connector-health.test.ts`
 * runs the real SQL against a Postgres when TEST_DATABASE_URL is set, and skips
 * with a printed reason when it is not (CI always sets one).
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    // Everything date-shaped here is UTC by construction (ymd() uses
    // toISOString), so a non-UTC CI box must not change an answer. Pinning a
    // real offset is what proves that.
    env: { TZ: "America/New_York" },
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
