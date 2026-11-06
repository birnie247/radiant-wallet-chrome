/**
 * Stub for the `ws` package.
 *
 * `@radiant-core/sdk` resolves its WebSocket constructor in this order:
 *   1. `globalThis.WebSocket`  <- always present in the Android WebView
 *   2. `await import("ws")`    <- Node-only fallback
 *
 * Vite aliases `ws` to this module so the Node-only fallback never drags
 * node:net / node:tls into the browser bundle. Reaching it means the global
 * WebSocket was missing, which is a genuine fatal condition.
 */
export default class WsUnavailable {
  constructor() {
    throw new Error("WebSocket is unavailable in this runtime");
  }
}
