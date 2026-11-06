/**
 * Transaction history with confirmation counts.
 *
 * Only standard ElectrumX methods are used — `blockchain.scripthash.get_history`,
 * `blockchain.transaction.get` (raw hex) and `blockchain.block.header` — so this
 * works against any Radiant ElectrumX server without depending on a proprietary
 * verbose-tx JSON shape.
 *
 * Parsing facts confirmed empirically against radiantjs (see
 * scripts/probe-tx-parse.mjs) rather than assumed:
 *   • `input.prevTxId` is ALREADY in display byte order — do NOT reverse it.
 *     Reversing would make every one of our own spends look like a foreign input.
 *   • `input.outputIndex` indexes the prevout's outputs.
 *   • `input.isNull()` identifies a coinbase input.
 *   • `output.satoshis` is a number; `output.script.toHex()` is the scriptPubKey.
 */
import { p2pkhScript, radiantjs, type ElectrumClient } from "@radiant-core/sdk";
import type { ScannedAddress } from "./wallet";

export interface HistoryEntry {
  txid: string;
  /** Block height, or 0 while still in the mempool. */
  height: number;
  /** 0 = unconfirmed. 1 = in the tip block. */
  confirmations: number;
  /** Block time (unix seconds) when confirmed. */
  time?: number;
  direction: "received" | "sent" | "self";
  /** Signed net effect on this wallet, in photons. */
  net: bigint;
  /** Only set when every input belongs to us (i.e. a normal send). */
  fee?: bigint;
  /**
   * True when an SPV merkle proof tied this transaction to a header whose chain
   * was verified back to the pinned checkpoint. Undefined means "not checked"
   * (still pending, too old for this build's checkpoint, or the check was skipped)
   * — never "checked and failed".
   */
  verified?: boolean;
  /** Why verification did not happen, for the tooltip/debug case. */
  verifyNote?: string;
}

interface HistoryRow {
  tx_hash: string;
  height: number;
}

/** Read the block timestamp out of an 80-byte header hex string. */
export function headerTime(headerHex: string): number | undefined {
  if (!headerHex || headerHex.length < 144) return undefined;
  const offset = 68 * 2; // the time field starts at byte 68
  const slice = headerHex.slice(offset, offset + 8);
  if (!/^[0-9a-fA-F]{8}$/.test(slice)) return undefined;
  const le = slice.match(/../g)!.reverse().join("");
  const seconds = parseInt(le, 16);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export interface LoadHistoryOptions {
  /** How many transactions to describe in detail. Default 25. */
  limit?: number;
  onProgress?: (message: string) => void;
}

export interface LoadHistoryResult {
  entries: HistoryEntry[];
  tipHeight: number;
  /** Total transactions seen across all addresses, before the limit. */
  totalKnown: number;
}

/**
 * Build a confirmation-annotated history for the wallet.
 * A row that cannot be resolved is skipped rather than breaking the whole list.
 */
export async function loadHistory(
  client: ElectrumClient,
  addresses: ScannedAddress[],
  options: LoadHistoryOptions = {},
): Promise<LoadHistoryResult> {
  const limit = options.limit ?? 25;
  const { onProgress } = options;

  // scriptPubKey hex -> owning address, for every address we watch.
  const ourScripts = new Set<string>();
  for (const entry of addresses) {
    try {
      ourScripts.add(p2pkhScript(entry.key.address));
    } catch {
      /* skip unusable address */
    }
  }

  onProgress?.("Loading transaction history…");
  const used = addresses.filter((a) => a.used);
  const perAddress = await mapLimit(used, 4, (a) =>
    client.getHistory(a.key.address).catch(() => [] as unknown[]),
  );

  const heights = new Map<string, number>();
  for (const rows of perAddress) {
    for (const raw of rows as HistoryRow[]) {
      if (!raw?.tx_hash) continue;
      const previous = heights.get(raw.tx_hash);
      if (previous === undefined || raw.height > previous) {
        heights.set(raw.tx_hash, raw.height);
      }
    }
  }

  const tipResp = await client
    .request<{ height: number }>("blockchain.headers.subscribe")
    .catch(() => ({ height: 0 }));
  const tipHeight = tipResp?.height ?? 0;

  const totalKnown = heights.size;
  // Mempool first, then newest blocks.
  const ordered = [...heights.entries()]
    .sort((a, b) => (a[1] === 0 ? -1 : b[1] === 0 ? 1 : b[1] - a[1]))
    .slice(0, limit);

  const txCache = new Map<string, any>();
  const timeCache = new Map<number, number | undefined>();

  async function getTx(txid: string): Promise<any | null> {
    if (txCache.has(txid)) return txCache.get(txid);
    try {
      const hex = await client.getTransaction(txid);
      if (typeof hex !== "string") {
        txCache.set(txid, null);
        return null;
      }
      const parsed = new radiantjs.Transaction(hex);
      txCache.set(txid, parsed);
      return parsed;
    } catch {
      txCache.set(txid, null);
      return null;
    }
  }

  async function getTime(height: number): Promise<number | undefined> {
    if (height <= 0) return undefined;
    if (timeCache.has(height)) return timeCache.get(height);
    let value: number | undefined;
    try {
      const headerHex = await client.request<string>(
        "blockchain.block.header",
        height,
      );
      value = headerTime(headerHex);
    } catch {
      value = undefined;
    }
    timeCache.set(height, value);
    return value;
  }

  onProgress?.(`Reading ${ordered.length} transaction(s)…`);
  const entries: HistoryEntry[] = [];

  for (const [txid, height] of ordered) {
    const tx = await getTx(txid);
    if (!tx) continue;

    let received = 0n;
    for (const output of tx.outputs) {
      if (ourScripts.has(output.script.toHex())) {
        received += BigInt(output.satoshis ?? 0);
      }
    }

    let spent = 0n;
    let allInputsOurs = true;
    let totalIn = 0n;
    let anyInput = false;

    for (const input of tx.inputs) {
      if (input.isNull?.()) {
        allInputsOurs = false;
        continue;
      }
      anyInput = true;
      // prevTxId is already in display order (verified empirically).
      // Convert without relying on a `Buffer` global, which is not guaranteed
      // inside the Android WebView.
      const prevTxid: string =
        typeof input.prevTxId === "string"
          ? input.prevTxId
          : Array.from(input.prevTxId as Uint8Array)
              .map((b: number) => b.toString(16).padStart(2, "0"))
              .join("");
      const prev = await getTx(prevTxid);
      const prevOut = prev?.outputs?.[input.outputIndex];
      if (!prevOut) {
        allInputsOurs = false;
        continue;
      }
      const value = BigInt(prevOut.satoshis ?? 0);
      totalIn += value;
      if (ourScripts.has(prevOut.script.toHex())) spent += value;
      else allInputsOurs = false;
    }

    const net = received - spent;
    const direction: HistoryEntry["direction"] =
      net > 0n ? "received" : net < 0n ? "sent" : "self";

    let fee: bigint | undefined;
    if (anyInput && allInputsOurs && direction === "sent") {
      const totalOut = tx.outputs.reduce(
        (sum: bigint, o: any) => sum + BigInt(o.satoshis ?? 0),
        0n,
      );
      const computed = totalIn - totalOut;
      if (computed > 0n) fee = computed;
    }

    entries.push({
      txid,
      height,
      confirmations:
        height > 0 && tipHeight >= height ? tipHeight - height + 1 : 0,
      time: await getTime(height),
      direction,
      net,
      fee,
    });
  }

  return { entries, tipHeight, totalKnown };
}
