import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest for apps/app-web. Scoped to pure-logic unit tests (no DOM)
 * — the `@/` alias mirrors the tsconfig path so `@/`-imported modules
 * resolve.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Shims `localStorage` for Node 26+ (its experimental built-in is undefined
    // without --localstorage-file and shadows jsdom's). See vitest.setup.ts.
    setupFiles: ["./vitest.setup.ts"],
  },
});
