import { defineConfig } from "vitest/config";

/**
 * Use a single fork so the module-level `state` in dispatch-queue.ts is
 * shared across tests in the same file. Without this, tests run in
 * parallel worker processes and the singleton appears empty.
 */
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});