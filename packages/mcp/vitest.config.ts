import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/in-memory.ts"],
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 10000,
    hookTimeout: 15000,
  },
});
