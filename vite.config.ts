import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    // radiantjs/lib/crypto/random.js branches on `process.browser` to choose Web
    // Crypto over Node's crypto.randomBytes. Without this the bundle takes the
    // Node path and key generation fails.
    "process.browser": "true",
    __APP_VERSION__: JSON.stringify(version),
  },
  resolve: {
    alias: {
      // The SDK imports `ws` only as a Node fallback; extension pages always have
      // a global WebSocket, so `ws` must never be bundled (it needs node:net).
      ws: fileURLToPath(new URL("./src/shims/ws.ts", import.meta.url)),
      // radiantjs feature-detects Node's crypto module and must fail that check
      // cleanly so it uses pure-JS + Web Crypto instead.
      crypto: fileURLToPath(new URL("./src/shims/crypto.ts", import.meta.url)),
      // Node's `assert` runs on the HD-key and transaction-serialisation paths,
      // i.e. exactly while signing — it needs a real callable implementation.
      assert: fileURLToPath(new URL("./src/shims/assert.cjs", import.meta.url)),
    },
  },
  build: {
    target: "chrome120",
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    // MV3 extension pages run under `script-src 'self'`, which blocks inline
    // scripts. Vite's modulepreload polyfill is injected as an inline script, so
    // it has to stay off or the popup fails to boot with a CSP error.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        popup: fileURLToPath(new URL("./popup.html", import.meta.url)),
        background: fileURLToPath(new URL("./src/background.ts", import.meta.url)),
      },
      output: {
        // The service worker must be a predictable path: manifest.json names it.
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: { port: 5174 },
});
