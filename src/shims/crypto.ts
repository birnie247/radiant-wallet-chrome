/**
 * Browser replacement for Node's `crypto`, tailored to radiantjs.
 *
 * radiantjs needs three things from `crypto`, and they behave differently:
 *
 * 1. `createHash`  — lib/crypto/hash.js FEATURE-DETECTS this:
 *      `if (nodeCrypto && typeof nodeCrypto.createHash === 'function')`
 *    so we must NOT provide it. Leaving it undefined makes hash.js use its
 *    pure-JS implementation (lib/crypto/hash.browser.js, backed by hash.js
 *    + js-sha512), which is verified against NIST vectors.
 *
 * 2. `createHmac`  — lib/mnemonic/pbkdf2.js calls it UNCONDITIONALLY on the
 *    BIP39 mnemonic -> seed path, with no fallback:
 *      `U = crypto.createHmac('sha512', key).update(block1).digest()`
 *    It also relies on the result being a real Buffer (`U.copy`, `U[k]`).
 *    We implement it over js-sha512, which radiantjs already depends on.
 *
 * 3. `randomBytes` — lib/crypto/random.js is steered to the Web Crypto path by
 *    the `process.browser` define in vite.config.ts; this is only a backstop,
 *    implemented with getRandomValues so it can never return weak entropy.
 */
import { Buffer } from "buffer";
import jsSha512 from "js-sha512";

/**
 * js-sha512 is CommonJS and its published typings do not declare the `hmac`
 * namespace, even though the runtime provides it (verified: sha512.hmac.create
 * exists on 0.8.0). Model just the small surface we use.
 */
interface HmacStream {
  update(data: unknown): void;
  arrayBuffer(): ArrayBuffer;
  hex(): string;
}

interface Sha512Lib {
  hmac: { create(key: unknown): HmacStream };
}

const sha512 = jsSha512 as unknown as Sha512Lib;

/** Deliberately absent: triggers radiantjs's pure-JS hasher. */
export const createHash = undefined;

type Bytes = Uint8Array | string;

interface HmacLike {
  update(data: Bytes): HmacLike;
  digest(encoding?: "hex"): Buffer | string;
}

function normaliseAlgo(algo: string): string {
  return algo.toLowerCase().replace(/[-_]/g, "");
}

/**
 * Minimal `crypto.createHmac` supporting SHA-512 — the only algorithm radiantjs
 * requests on the mnemonic path. Anything else fails loudly rather than
 * producing a subtly wrong seed.
 */
export function createHmac(algo: string, key: Bytes): HmacLike {
  const name = normaliseAlgo(algo);
  if (name !== "sha512") {
    throw new Error(`crypto.createHmac: unsupported algorithm "${algo}"`);
  }

  const instance = sha512.hmac.create(key as never);

  const api: HmacLike = {
    update(data: Bytes) {
      instance.update(data as never);
      return api;
    },
    digest(encoding?: "hex") {
      if (encoding === "hex") return instance.hex();
      return Buffer.from(instance.arrayBuffer());
    },
  };
  return api;
}

export function randomBytes(size: number): Buffer {
  const out = new Uint8Array(size);
  const webCrypto = globalThis.crypto;
  if (!webCrypto?.getRandomValues) {
    throw new Error("No secure RNG available (crypto.getRandomValues missing)");
  }
  webCrypto.getRandomValues(out);
  return Buffer.from(out);
}

export default { createHash, createHmac, randomBytes };

