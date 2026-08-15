import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/helpers/next-headers-mock.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
    // Characterization tests hit a real (temp, file-backed) SQLite database
    // per test — run files in parallel, but keep tests within a file
    // sequential so concurrency tests control interleaving deliberately
    // rather than fighting the runner's own parallelism.
    fileParallelism: true,
    sequence: { concurrent: false },
  },
});
