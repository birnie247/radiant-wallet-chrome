import { defineConfig } from "vite";
import base from "./vite.config.ts";

/**
 * Config for the runtime check in scripts/browser-path-check.ts.
 *
 * It inherits every alias/define from vite.config.ts (the crypto, assert and ws
 * shims plus `process.browser`) but forces the Radiant packages to be BUNDLED
 * rather than externalized, so the shims are genuinely exercised. The popup entry
 * and service worker are dropped here — this build is only the test program.
 */
export default defineConfig({
  ...base,
  ssr: {
    noExternal: true,
    target: "node",
  },
  build: {
    ssr: "scripts/browser-path-check.ts",
    outDir: "dist-test",
    emptyOutDir: true,
    target: "es2022",
    minify: false,
    modulePreload: false,
    rollupOptions: { input: undefined },
  },
});
