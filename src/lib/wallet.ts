/**
 * Wallet engine: HD discovery, balance aggregation and ref-safe payments.
 *
 * Design notes that matter for correctness:
 *
 * 1. RADIANT REFS. A UTXO that carries a Glyph FT/NFT has an
 *    OP_PUSHINPUTREF-family opcode inside its output script. Spending such a
 *    UTXO as ordinary fee funding BURNS the token. Every funding path here goes
 *    through the SDK's `selectRxdFunding`, which screens candidates by both
 *    indexer-reported refs and a local opcode scan.
 *
 * 2. SIGNING ORDER. `buildTx` picks the signing key by INPUT INDEX
 *    (`privKeys[index]`), not by matching the address. The wif array therefore
 *    must stay exactly parallel to the inputs array. We build both together in
 *    one pass so they can never drift.
 *
 * 3. CHANGE. `buildTx` sends change to a single address. We point it at the
 *    first unused address of the BIP44 change chain, which the scanner already
 *    watches, so change is never stranded.
 */
import {
  ElectrumClient,
  HDWallet,
  buildTx,
  p2pkhScript,
  selectRxdFunding,
  type DerivedKey,
  type NetworkName,
  type Utxo,
} from "@radiant-core/sdk";
import { autoCandidates, crossCheckCandidates, findServer } from "./servers";
import { LEGACY_COIN_TYPE, RADIANT_COIN_TYPE } from "./vault";

export const GAP_LIMIT = 20;
export const HARD_ADDRESS_CAP = 200;
export const MIN_FEE_RATE = 10_000n;
export const FAST_FEE_RATE = 50_000n;

export interface ScannedAddress {
  key: DerivedKey;
  used: boolean;
  change: number;
}

export interface OwnedUtxo extends Utxo {
  ownerAddress: string;
  ownerWif: string;
  ownerIndex: number;
  ownerChange: number;
}

export interface ScanResult {
  addresses: ScannedAddress[];
  utxos: OwnedUtxo[];
  confirmed: bigint;
  unconfirmed: bigint;
  total: bigint;
  /** UTXOs deliberately excluded from funding because they carry a token ref. */
  tokenUtxoCount: number;
  nextReceive: DerivedKey;
  nextChange: DerivedKey;
}

export interface PaymentPlan {
  hex: string;
  txid: string;
  fee: bigint;
  inputsUsed: number;
  inputValue: bigint;
  change: bigint;
}

/** Run `fn` over `items` with bounded concurrency. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface Connection {
  client: ElectrumClient;
  endpoint: string;
  /** True when this endpoint is one of the curated, handshake-verified nodes. */
  verified: boolean;
  /** Administrator grouping, used for independent cross-checks. */
  operator: string;
  /**
   * Raw `server.version` reply from the endpoint that answered (ElectrumX sends
   * `[banner, protocol]`). Carried here so Settings can show *what* responded
   * without a second round trip - ElectrumX rejects a repeat handshake.
   */
  serverVersion?: unknown;
}

/**
 * How long the whole connection sequence may take.
 *
 * These are deliberately tighter than a browser default: several endpoints are
 * tried in turn, so a generous per-host timeout multiplies into a long silence.
 * Budgeting the sequence means "no network" surfaces in ~20s, not ~70s.
 */
export const CONNECT_TIMEOUT_MS = 7_000;
export const HANDSHAKE_TIMEOUT_MS = 4_000;
export const CONNECT_BUDGET_MS = 20_000;
/** Never start an attempt that cannot finish inside the remaining budget. */
const MIN_ATTEMPT_MS = 3_000;

export interface ConnectOptions {
  /** Override the endpoints to try (tests, diagnostics). */
  candidates?: string[];
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  budgetMs?: number;
}

/** `wss://host:port` -> `host` for readable messages. */
function hostOf(url: string): string {
  return url.replace(/^wss?:\/\//, "").replace(/[:/].*$/, "");
}

/**
 * Build a failure the user can act on.
 *
 * A WebSocket error carries no reason — the browser hides DNS vs refused vs
 * blocked for security — so this reports what was tried and the usual causes
 * instead of inventing a specific one.
 */
export function connectFailureMessage(
  network: NetworkName,
  errors: string[],
): string {
  const offline =
    typeof navigator !== "undefined" && navigator.onLine === false;
  if (offline) {
    return "You're offline. Connect to Wi-Fi or mobile data, then try again.";
  }
  const lines = [
    `Couldn't reach a Radiant ${network} server.`,
    "Your connection may be down, or a firewall/VPN may be blocking it.",
  ];
  if (errors.length > 0) lines.push("", ...errors.slice(0, 4));
  return lines.join("\n");
}

/**
 * Connect to the first ElectrumX server that completes a handshake.
 * A dead endpoint is skipped, and the whole sequence is bounded by a budget.
 */
export async function connect(
  network: NetworkName,
  preferred?: string,
  onAttempt?: (url: string) => void,
  options: ConnectOptions = {},
): Promise<Connection> {
  const {
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
    budgetMs = CONNECT_BUDGET_MS,
  } = options;

  const candidates = options.candidates ?? autoCandidates(network, preferred);
  if (candidates.length === 0) {
    throw new Error(`No Radiant ${network} server is configured.`);
  }

  const startedAt = Date.now();
  const errors: string[] = [];

  for (const url of candidates) {
    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining < MIN_ATTEMPT_MS) {
      errors.push(`${hostOf(url)}: skipped, out of time`);
      break;
    }

    onAttempt?.(url);
    const client = new ElectrumClient({ endpoint: url, reconnect: true });
    try {
      await withTimeout(
        client.connect(),
        Math.min(connectTimeoutMs, remaining),
        "connect",
      );
      const version = await withTimeout(
        client.serverVersion("rxd-chrome-wallet", "1.4"),
        Math.min(handshakeTimeoutMs, remaining),
        "handshake",
      );
      const entry = findServer(network, url);
      return {
        client,
        endpoint: url,
        verified: entry?.verified ?? false,
        operator: entry?.operator ?? "unknown",
        serverVersion: version,
      };
    } catch (err) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
      errors.push(`${hostOf(url)}: ${(err as Error).message}`);
    }
  }

  throw new Error(connectFailureMessage(network, errors));
}

export interface TipCheck {
  endpoint: string;
  operator: string;
  height: number;
}

/** How far apart two servers' tips may be before we call it a disagreement. */
export const MAX_TIP_DRIFT = 2;

/**
 * Ask a *different operator's* server for its chain tip.
 *
 * Security report MEDIUM-2: the app otherwise trusts a single Electrum server
 * for balances, history and confirmation counts. A lying or badly stale server
 * can therefore fake confirmations. This does not deliver SPV (no merkle/PoW
 * verification) but it does detect gross disagreement between independent
 * operators, which is the cheap 80% of the value.
 *
 * Returns null when no independent server is reachable.
 */
export async function crossCheckTip(
  network: NetworkName,
  primaryEndpoint: string,
  timeoutMs = 5_000,
): Promise<TipCheck | null> {
  // Bounded: at most two peers, each from a DIFFERENT operator, each with a short
  // timeout. This runs on the refresh path, so a dead peer must never cost the user
  // more than ~10s - and the second peer must be a second *opinion*, not a second
  // host belonging to the same administrator (see crossCheckCandidates).
  for (const entry of crossCheckCandidates(network, primaryEndpoint)) {
    const client = new ElectrumClient({ endpoint: entry.url, reconnect: false });
    try {
      await withTimeout(client.connect(), timeoutMs, `connect ${entry.url}`);
      const tip = await withTimeout(
        client.request<{ height: number }>("blockchain.headers.subscribe"),
        timeoutMs,
        `tip ${entry.url}`,
      );
      const height = Number(tip?.height);
      if (Number.isFinite(height) && height > 0) {
        return { endpoint: entry.url, operator: entry.operator, height };
      }
    } catch {
      /* try the next independent operator */
    } finally {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

/**
 * Walk one BIP44 chain until the gap limit is satisfied.
 * `change` is 0 for the receive chain, 1 for the change chain.
 */
async function scanChain(
  client: ElectrumClient,
  wallet: HDWallet,
  change: number,
  onProgress?: (scanned: number) => void,
): Promise<ScannedAddress[]> {
  const out: ScannedAddress[] = [];
  let start = 0;
  let lastUsed = -1;

  while (start < HARD_ADDRESS_CAP) {
    const batch = wallet.deriveRange(start, GAP_LIMIT, change);
    const histories = await mapLimit(batch, 6, (k) =>
      client.getHistory(k.address).catch(() => [] as unknown[]),
    );

    batch.forEach((key, i) => {
      const used = (histories[i]?.length ?? 0) > 0;
      out.push({ key, used, change });
      if (used) lastUsed = key.index;
    });

    start += GAP_LIMIT;
    onProgress?.(out.length);
    // Stop once the gap limit is satisfied past the last activity.
    if (lastUsed < 0) break;
    if (start - lastUsed > GAP_LIMIT) break;
  }

  return out;
}

export interface ScanOptions {
  onProgress?: (message: string) => void;
}

/** Full wallet scan: discover addresses, then collect their UTXOs. */
export async function scanWallet(
  client: ElectrumClient,
  wallet: HDWallet,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const { onProgress } = options;

  onProgress?.("Discovering receive addresses…");
  const receive = await scanChain(client, wallet, 0, (n) =>
    onProgress?.(`Scanning receive addresses (${n})…`),
  );

  onProgress?.("Discovering change addresses…");
  const changeChain = await scanChain(client, wallet, 1, (n) =>
    onProgress?.(`Scanning change addresses (${n})…`),
  );

  const all = [...receive, ...changeChain];
  const used = all.filter((a) => a.used);

  onProgress?.(`Reading ${used.length} active address(es)…`);
  const unspentPerAddress = await mapLimit(used, 4, (entry) =>
    client.listUnspent(entry.key.address).catch(() => [] as Utxo[]),
  );

  const utxos: OwnedUtxo[] = [];
  used.forEach((entry, i) => {
    for (const u of unspentPerAddress[i]) {
      utxos.push({
        ...u,
        ownerAddress: entry.key.address,
        ownerWif: entry.key.wif,
        ownerIndex: entry.key.index,
        ownerChange: entry.change,
      });
    }
  });

  let confirmed = 0n;
  let unconfirmed = 0n;
  let tokenUtxoCount = 0;
  for (const u of utxos) {
    if ((u.refs?.length ?? 0) > 0) tokenUtxoCount++;
    if ((u.height ?? 0) > 0) confirmed += u.value;
    else unconfirmed += u.value;
  }

  const nextReceive =
    receive.find((a) => !a.used)?.key ?? wallet.deriveKey(receive.length, 0);
  const nextChange =
    changeChain.find((a) => !a.used)?.key ??
    wallet.deriveKey(changeChain.length, 1);

  return {
    addresses: all,
    utxos,
    confirmed,
    unconfirmed,
    total: confirmed + unconfirmed,
    tokenUtxoCount,
    nextReceive,
    nextChange,
  };
}

/* ------------------------------------------------- derivation detection --- */

/** Addresses per chain probed when guessing a seed's derivation. */
export const DETECT_ADDRESSES = 20;

export interface CoinTypeGuess {
  /** Coin type to derive with: 512 (current) or 0 (pre-512 wallets). */
  coinType: number;
  /** History rows seen per candidate coin type, across both chains. */
  hits: Record<number, number>;
  /** True when no server answered, so nothing was actually compared. */
  inconclusive: boolean;
}

/**
 * Work out which SLIP-44 coin type a recovery phrase was derived under.
 *
 * The same phrase under coin type 512 and coin type 0 yields two *disjoint*
 * address sets, and there is no offline way to tell which one a wallet used.
 * The only honest test is to ask the chain: derive the first
 * {@link DETECT_ADDRESSES} addresses of both the receive and change chains for
 * each candidate and count history rows. An old wallet shows activity on 0 and
 * silence on 512 — which is precisely the question "why is my restored wallet
 * empty?".
 *
 * Both chains are probed because a wallet that has only ever *sent* keeps its
 * remaining funds on `…/1/i`; checking the receive chain alone would call such a
 * seed unused.
 *
 * Never throws: unreachable servers return the default marked `inconclusive`,
 * because a failed probe must not block a restore. Settings can switch it later.
 */
export async function detectCoinType(
  client: ElectrumClient,
  mnemonic: string,
  network: NetworkName,
): Promise<CoinTypeGuess> {
  const candidates = [RADIANT_COIN_TYPE, LEGACY_COIN_TYPE];
  const hits: Record<number, number> = {};
  let answered = 0;

  for (const coinType of candidates) {
    let wallet: HDWallet;
    try {
      wallet = HDWallet.fromMnemonic(mnemonic, { network, coinType });
    } catch {
      hits[coinType] = 0;
      continue;
    }
    const keys = [0, 1].flatMap((change) =>
      wallet.deriveRange(0, DETECT_ADDRESSES, change),
    );
    const rows = await mapLimit(keys, 6, async (key) => {
      try {
        const history = await client.getHistory(key.address);
        answered++;
        return history.length;
      } catch {
        return 0;
      }
    });
    hits[coinType] = rows.reduce((sum, n) => sum + n, 0);
  }

  const inconclusive = answered === 0;
  // Only move off the default when the legacy set is strictly busier: both-empty
  // (a fresh phrase) and activity-in-both (impossible in practice) stay on 512.
  const coinType =
    !inconclusive && hits[LEGACY_COIN_TYPE] > hits[RADIANT_COIN_TYPE]
      ? LEGACY_COIN_TYPE
      : RADIANT_COIN_TYPE;

  return { coinType, hits, inconclusive };
}

export interface DetectSeedOptions {
  network?: NetworkName;
  server?: string;
  /**
   * Connection budget. Shorter than a normal connect on purpose: this runs while
   * the user waits on the restore screen, and an unreachable server must fall
   * back to the default quickly rather than stall the restore for 20s.
   */
  budgetMs?: number;
  onProgress?: (message: string) => void;
}

/**
 * {@link detectCoinType} with its own short-lived connection, for the restore
 * flow — at that point the wallet is not open yet, so there is no client to
 * borrow. The socket is always closed, including on failure.
 *
 * The probe reveals {@link DETECT_ADDRESSES} addresses of each set to whichever
 * server answers. They are derived from the user's own phrase and mostly unused,
 * but the server does see them — that is stated in the docs and release notes
 * rather than left implicit.
 */
export async function detectSeedDerivation(
  mnemonic: string,
  options: DetectSeedOptions = {},
): Promise<CoinTypeGuess> {
  const network = options.network ?? "mainnet";
  let connection: Connection | null = null;
  try {
    options.onProgress?.("Checking which address set this phrase uses…");
    connection = await connect(network, options.server, undefined, {
      budgetMs: options.budgetMs ?? 10_000,
    });
    return await detectCoinType(connection.client, mnemonic, network);
  } catch {
    return {
      coinType: RADIANT_COIN_TYPE,
      hits: { [RADIANT_COIN_TYPE]: 0, [LEGACY_COIN_TYPE]: 0 },
      inconclusive: true,
    };
  } finally {
    try {
      connection?.client.close();
    } catch {
      /* ignore */
    }
  }
}

export type AddressCheck = { ok: true } | { ok: false; error: string };

/**
 * Validate a destination address.
 *
 * Radiant is a P2PKH/P2SH chain (no SegWit/bech32). We validate by re-deriving
 * the P2PKH script — an invalid base58 payload or bad checksum throws — and
 * then check the version prefix. Mainnet only: testnet support was removed, so a
 * testnet-looking address must be rejected rather than quietly accepted.
 */
export function checkAddress(address: string): AddressCheck {
  const value = address.trim();
  if (!value) return { ok: false, error: "Enter a destination address" };

  let script: string;
  try {
    script = p2pkhScript(value);
  } catch {
    return {
      ok: false,
      error: "Not a valid Radiant address (bad checksum or length)",
    };
  }
  if (!/^76a914[0-9a-f]{40}88ac$/.test(script)) {
    return { ok: false, error: "Unsupported address type — P2PKH only" };
  }

  if (!"13".includes(value[0])) {
    return {
      ok: false,
      error: "That looks like a testnet address — this wallet is mainnet only",
    };
  }
  return { ok: true };
}

export interface BuildPaymentParams {
  scan: ScanResult;
  to: string;
  amount: bigint;
  feeRate?: bigint;
  network: NetworkName;
}

/**
 * Build and sign a ref-safe RXD payment.
 * Never touches the network — the caller broadcasts.
 */
export function buildPayment({
  scan,
  to,
  amount,
  feeRate = MIN_FEE_RATE,
  network,
}: BuildPaymentParams): PaymentPlan {
  if (amount <= 0n) throw new Error("Amount must be greater than zero");

  const check = checkAddress(to);
  if (!check.ok) throw new Error(check.error);

  const funding: Utxo[] = scan.utxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: u.value,
    script: u.script,
    height: u.height,
    refs: u.refs,
  }));

  // Throws InsufficientFundsError / TokenBurnGuardError from the SDK.
  const selection = selectRxdFunding(funding, amount, feeRate, {
    baseOutputCount: 1,
    withChange: true,
  });

  // Preserve selection order — it defines the signing-key order.
  const chosen = selection.inputs.map((selected) => {
    const match = scan.utxos.find(
      (u) => u.txid === selected.txid && u.vout === selected.vout,
    );
    if (!match) {
      throw new Error(
        "Internal error: selected UTXO is not owned by this wallet",
      );
    }
    return match;
  });

  const built = buildTx({
    // Change destination: an already-watched, unused change-chain address.
    address: scan.nextChange.address,
    wif: chosen.map((u) => u.ownerWif),
    inputs: chosen.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      script: u.script,
    })),
    outputs: [{ script: p2pkhScript(to.trim()), value: amount }],
    feeRate,
    addChange: true,
    network,
  });

  const inputValue = chosen.reduce((sum, u) => sum + u.value, 0n);
  const outputValue = built.outputs.reduce((sum, o) => sum + o.value, 0n);
  const fee = inputValue - outputValue;

  if (fee < 0n) throw new Error("Internal error: negative fee");

  return {
    hex: built.hex,
    txid: built.txid,
    fee,
    inputsUsed: chosen.length,
    inputValue,
    change: selection.change,
  };
}

/** Broadcast a signed transaction, returning the txid the wallet computed. */
export async function broadcast(
  client: ElectrumClient,
  plan: PaymentPlan,
): Promise<string> {
  await client.broadcastTx(plan.hex);
  return plan.txid;
}
