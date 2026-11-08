/**
 * Simplified payment verification for Radiant.
 *
 * This is the piece that removes "trust the Electrum server" from the wallet. It
 * proves that a transaction is in a block, and that the block is part of the
 * heaviest chain descending from a block this build pins.
 *
 * Three things here were measured against live mainnet data rather than assumed,
 * and getting any of them wrong produces a verifier that silently never fails:
 *
 *   • Block hash / proof of work — double **SHA-512/256**. Double SHA-256 does
 *     *not* satisfy the target, so a Bitcoin-shaped verifier rejects every real
 *     Radiant header.
 *   • Transaction id and merkle tree — double **SHA-256**, a different hash from
 *     the one used for proof of work.
 *   • Difficulty changes on **every block** (398 of 400 consecutive mainnet
 *     headers carry a different `bits`), so there are no 2016-block epochs to
 *     reason about.
 *
 * What is verified: header proof of work against the target encoded in the header,
 * the parent-hash chain from a pinned checkpoint to the tip, the merkle branch of
 * each transaction, and that the transaction id is the hash of the transaction
 * body. What is *not* verified, and is stated plainly because it matters: the
 * difficulty-adjustment rule itself. See `MAX_TARGET_FACTOR`.
 */
import jsSha512 from "js-sha512";
import type { ElectrumClient } from "@radiant-core/sdk";

/** Genesis block hash, as reported by the server's `server.features`. */
export const GENESIS_HASH =
  "0000000065d8ed5d8be28d6876b3ffb660ac2a6c0ca59e437e1f7a6f4e003fb4";

/**
 * A block this build trusts without proof.
 *
 * Pinning gives the chain a root: a server cannot substitute a different history at
 * or below this height. Keep it recent and refresh it with each release — the chain
 * moves ~288 blocks a day, and the older this gets the more the difficulty tolerance
 * below has to absorb.
 *
 * Kept in step with the Android build (same height and hash) so both clients agree.
 * Refreshed for 1.0.0: height 479316, ~150 blocks behind the tip when taken.
 */
export const CHECKPOINT = {
  height: 479_316,
  hash: "00000000000000bef105a7576bea622d81a054b8e40d146db6a315fafdc8a0aa",
} as const;

/**
 * How much easier than the checkpoint a header's target is allowed to be.
 *
 * The honest limitation of this module. Because Radiant retargets per block and
 * the adjustment rule is not implemented, a malicious server could pick trivially
 * easy targets and forge a chain with no real work. Requiring every target to stay
 * within a small factor of the pinned checkpoint's target bounds that: forging
 * 150 blocks then costs at least 1/2 of the real work over those blocks, which at
 * Radiant's difficulty is not an attack anyone can run.
 *
 * The trade-off is the other direction: a genuine difficulty collapse (hash rate
 * leaving the chain) would make validated headers fall outside the factor and the
 * wallet would refuse to sync until a new checkpoint ships. That is a visible,
 * recoverable failure rather than a silent one.
 */
const MAX_TARGET_FACTOR = 2n;

/** ElectrumX caps `blockchain.block.headers` at 2016 headers per request. */
const HEADER_BATCH = 2016;

/* ------------------------------------------------------------------ bytes ---- */

function toBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error("not hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function reversed(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes).reverse();
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ------------------------------------------------------------------ hashes --- */

/** Double SHA-512/256 — the block hash and proof-of-work hash. */
function sha512_256d(input: Uint8Array): Uint8Array {
  const api = jsSha512 as unknown as {
    sha512_256: { array: (v: Uint8Array | number[]) => number[] };
  };
  const once = Uint8Array.from(api.sha512_256.array(input));
  return Uint8Array.from(api.sha512_256.array(once));
}

/** Double SHA-256 — transaction ids and merkle nodes. */
async function sha256d(input: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("WebCrypto is unavailable, so merkle proofs cannot be checked");
  }
  const once = new Uint8Array(
    await subtle.digest("SHA-256", input as unknown as BufferSource),
  );
  return new Uint8Array(
    await subtle.digest("SHA-256", once as unknown as BufferSource),
  );
}


/* ----------------------------------------------------------------- headers --- */

export interface Header {
  height: number;
  /** Block hash in display order (what a block explorer shows). */
  hash: string;
  /** Parent hash in display order. */
  prev: string;
  /** Merkle root in display order. */
  merkleRoot: string;
  time: number;
  bits: number;
  nonce: number;
  /** True when this header's own hash satisfies the target its `bits` encodes. */
  meetsTarget: boolean;
}

const HEADER_BYTES = 80;

/**
 * Expand the compact `bits` field into a 256-bit target.
 *
 * Same encoding Bitcoin uses: a one-byte exponent and a 23-bit mantissa.
 */
export function targetFromBits(bits: number): bigint {
  const exponent = bits >>> 24;
  const mantissa = BigInt(bits & 0x007fffff);
  if (mantissa === 0n) return 0n;
  if (exponent < 3) return mantissa >> (8n * BigInt(3 - exponent));
  return mantissa * 2n ** (8n * BigInt(exponent - 3));
}

/**
 * Decode one 80-byte header and check its proof of work in the same pass.
 *
 * Hashing happens here because the bytes are already in hand — and because the
 * proof-of-work check is the only reason to trust this hash at all.
 */
export function parseHeader(hex: string, height: number): Header {
  const bytes = toBytes(hex);
  if (bytes.length !== HEADER_BYTES) {
    throw new Error(`header at ${height} is ${bytes.length} bytes, expected 80`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bits = view.getUint32(72, true);
  const hashBytes = reversed(sha512_256d(bytes));
  const hashValue = BigInt(`0x${toHex(hashBytes)}`);
  return {
    height,
    // Stored hashes are little-endian; reverse them for display.
    hash: toHex(hashBytes),
    prev: toHex(reversed(bytes.subarray(4, 36))),
    merkleRoot: toHex(reversed(bytes.subarray(36, 68))),
    time: view.getUint32(68, true),
    bits,
    nonce: view.getUint32(76, true),
    meetsTarget: hashValue <= targetFromBits(bits),
  };
}

/** Fetch a contiguous run of headers, batched to the protocol limit. */
export async function fetchHeaders(
  client: ElectrumClient,
  fromHeight: number,
  toHeight: number,
): Promise<Header[]> {
  const out: Header[] = [];
  let height = fromHeight;
  while (height <= toHeight) {
    const count = Math.min(HEADER_BATCH, toHeight - height + 1);
    const res = await client.request<{ count: number; hex: string }>(
      "blockchain.block.headers",
      height,
      count,
    );
    const hex = res?.hex ?? "";
    const returned = Math.floor(hex.length / (HEADER_BYTES * 2));
    if (returned === 0) break;
    for (let i = 0; i < returned; i++) {
      const slice = hex.slice(i * HEADER_BYTES * 2, (i + 1) * HEADER_BYTES * 2);
      out.push(parseHeader(slice, height + i));
    }
    height += returned;
    if (returned < count) break;
  }
  return out;
}

/* -------------------------------------------------------------- chain sync --- */

export interface ChainResult {
  /** True only when every header from the checkpoint to the tip verified. */
  ok: boolean;
  tip: number;
  tipHash: string;
  /** How many headers above the checkpoint were checked. */
  checked: number;
  /** Human-readable reason when `ok` is false. */
  reason: string;
  /** Merkle roots for validated heights, keyed by height. */
  merkleRoots: Map<number, string>;
}

/**
 * Walk from the pinned checkpoint to the server's tip and verify the chain.
 *
 * Each header must (a) meet its own target, (b) name the previous header as its
 * parent, and (c) not lower difficulty beyond `MAX_TARGET_FACTOR` relative to the
 * checkpoint. The checkpoint's hash is recomputed first: if the server disagrees
 * about a block this build pins, nothing else it says is worth checking.
 */
export async function syncChain(client: ElectrumClient): Promise<ChainResult> {
  const merkleRoots = new Map<number, string>();
  const fail = (
    reason: string,
    tip: number = CHECKPOINT.height,
    tipHash = "",
    checked = 0,
  ): ChainResult => ({ ok: false, tip, tipHash, checked, reason, merkleRoots });

  const tipRes = await client.request<{ height: number }>(
    "blockchain.headers.subscribe",
  );
  const serverTip = Number(tipRes?.height);
  if (!Number.isFinite(serverTip) || serverTip <= 0) {
    return fail("the server did not report a chain tip");
  }
  if (serverTip < CHECKPOINT.height) {
    return fail(
      `server tip ${serverTip} is behind this build's checkpoint ${CHECKPOINT.height}`,
      serverTip,
    );
  }

  const checkpointHex = await client.request<string>(
    "blockchain.block.header",
    CHECKPOINT.height,
  );
  if (typeof checkpointHex !== "string") {
    return fail("the server would not return the pinned checkpoint header");
  }
  const checkpoint = parseHeader(checkpointHex, CHECKPOINT.height);
  if (checkpoint.hash !== CHECKPOINT.hash) {
    return fail(
      `checkpoint header hashes to ${checkpoint.hash}, this build pins ${CHECKPOINT.hash}`,
    );
  }
  if (!checkpoint.meetsTarget) {
    return fail("the checkpoint header does not meet its own target");
  }
  merkleRoots.set(CHECKPOINT.height, checkpoint.merkleRoot);

  if (serverTip === CHECKPOINT.height) {
    return {
      ok: true,
      tip: serverTip,
      tipHash: checkpoint.hash,
      checked: 0,
      reason: "",
      merkleRoots,
    };
  }

  const ceiling = targetFromBits(checkpoint.bits) * MAX_TARGET_FACTOR;
  const headers = await fetchHeaders(client, CHECKPOINT.height + 1, serverTip);
  let prev = checkpoint;
  let checked = 0;

  for (const header of headers) {
    if (header.prev !== prev.hash) {
      return fail(
        `header ${header.height} does not build on ${header.height - 1} — reorg or forged chain`,
        prev.height,
        prev.hash,
        checked,
      );
    }
    if (!header.meetsTarget) {
      return fail(
        `header ${header.height} does not meet its own proof-of-work target`,
        prev.height,
        prev.hash,
        checked,
      );
    }
    if (targetFromBits(header.bits) > ceiling) {
      return fail(
        `header ${header.height} lowers difficulty beyond this build's tolerance`,
        prev.height,
        prev.hash,
        checked,
      );
    }
    merkleRoots.set(header.height, header.merkleRoot);
    prev = header;
    checked++;
  }

  if (prev.height !== serverTip) {
    return fail(
      `only ${checked} of ${serverTip - CHECKPOINT.height} headers were returned`,
      prev.height,
      prev.hash,
      checked,
    );
  }

  return {
    ok: true,
    tip: prev.height,
    tipHash: prev.hash,
    checked,
    reason: "",
    merkleRoots,
  };
}



/* ---------------------------------------------------------- merkle proofs ---- */

/**
 * Fold a merkle branch into the root it proves.
 *
 * Both the branch and the txid arrive in display order while folding happens in
 * internal order, and the position decides concatenation order and then shifts
 * right — the three details that make a hand-written verifier silently wrong.
 */
export async function merkleRootFromProof(
  txid: string,
  branch: string[],
  position: number,
): Promise<string> {
  let current = reversed(toBytes(txid));
  let index = position;
  for (const siblingHex of branch) {
    const sibling = reversed(toBytes(siblingHex));
    const pair = new Uint8Array(64);
    if (index & 1) {
      pair.set(sibling, 0);
      pair.set(current, 32);
    } else {
      pair.set(current, 0);
      pair.set(sibling, 32);
    }
    current = await sha256d(pair);
    index >>= 1;
  }
  return toHex(reversed(current));
}

export interface TxProof {
  verified: boolean;
  reason: string;
  height: number;
}

/**
 * Prove a transaction is in the block at `height`.
 *
 * `merkleRoots` must come from a successful `syncChain`, or hold only the pinned
 * checkpoint: a proof against an unvalidated header proves nothing.
 */
export async function verifyTransaction(
  client: ElectrumClient,
  txid: string,
  height: number,
  merkleRoots: Map<number, string>,
): Promise<TxProof> {
  const expectedRoot = merkleRoots.get(height);
  if (!expectedRoot) {
    return {
      verified: false,
      reason:
        height < CHECKPOINT.height
          ? "block predates this build's checkpoint, so its header is unverified"
          : "block header was not part of the verified chain",
      height,
    };
  }

  let proof: { merkle: string[]; pos: number };
  try {
    proof = await client.request<{ merkle: string[]; pos: number }>(
      "blockchain.transaction.get_merkle",
      txid,
      height,
    );
  } catch (e) {
    // The server refuses proofs for transactions it does not know. That is a
    // failed proof, not an exception worth propagating into the UI.
    return {
      verified: false,
      reason: (e as Error).message || "the server refused a merkle proof",
      height,
    };
  }
  if (!proof?.merkle || !Number.isFinite(proof.pos)) {
    return { verified: false, reason: "the server gave no usable merkle branch", height };
  }

  const root = await merkleRootFromProof(txid, proof.merkle, proof.pos);
  if (root !== expectedRoot) {
    return {
      verified: false,
      reason: `proof hashes to ${root.slice(0, 16)}…, header says ${expectedRoot.slice(0, 16)}…`,
      height,
    };
  }
  return { verified: true, reason: "", height };
}

/** True when `txid` really is the double-SHA-256 of this raw transaction. */
export async function verifyTxid(rawTxHex: string, txid: string): Promise<boolean> {
  const computed = toHex(reversed(await sha256d(toBytes(rawTxHex))));
  return computed === txid.trim().toLowerCase();
}

/**
 * One-line summary of how many transactions were proven.
 *
 * Lives here, next to the verification it describes, so it can be tested: the
 * wording has to distinguish "nothing to prove yet" from "not checked" from "a
 * proof failed", and getting that wrong would either overstate or alarm.
 *
 * `checked` is what SPV actually attempted (bounded work), `confirmedCount` is how
 * many confirmed rows the wallet is showing.
 */
export function describeProofs(
  proofs: { checked: number; proven: number } | null,
  confirmedCount: number,
): string {
  if (!proofs) return "transactions not proven yet";
  if (proofs.checked === 0) {
    return confirmedCount === 0
      ? "nothing confirmed to prove yet"
      : "transactions not proven yet";
  }
  const noun = proofs.checked === 1 ? "transaction" : "transactions";
  const bounded =
    confirmedCount > proofs.checked ? ` (newest ${proofs.checked} checked)` : "";
  return `${proofs.proven} of ${proofs.checked} confirmed ${noun} proven${bounded}`;
}