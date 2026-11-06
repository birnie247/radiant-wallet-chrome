/**
 * Browser globals required by the Radiant libraries.
 *
 * MUST be imported before anything that pulls in `@radiant-core/radiantjs` or
 * `@radiant-core/sdk`. ES modules evaluate in import order, so as long as this
 * is the first import in main.tsx, the assignment below runs before any library
 * module body.
 *
 * Why this is needed: radiantjs and its dependencies (bs58, aes-js, p2pkh
 * helpers, bufferwriter) were written for Node and reference a bare `Buffer`
 * global in some code paths. In Node that global exists, which is exactly why
 * the Node-based test suite did NOT catch this — in a WebView the bundle threw
 * `ReferenceError: Buffer is not defined` at startup and the app showed a black
 * screen.
 *
 * Verification: `npm run check:smoke` loads the real built bundle in headless
 * Chrome and fails if the app does not mount.
 */
import { Buffer as BufferPolyfill } from "buffer";

const g = globalThis as unknown as {
  Buffer?: unknown;
  global?: unknown;
  process?: unknown;
};

if (typeof g.Buffer === "undefined") {
  g.Buffer = BufferPolyfill;
}

// A few Node-oriented packages also reach for `global`.
if (typeof g.global === "undefined") {
  g.global = globalThis;
}

// Minimal `process` shim: some libraries read process.env.NODE_ENV or
// process.nextTick without feature-detecting first.
if (typeof g.process === "undefined") {
  g.process = {
    env: { NODE_ENV: "production" },
    browser: true,
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) =>
      Promise.resolve().then(() => fn(...args)),
    versions: {},
  };
}

export {};
