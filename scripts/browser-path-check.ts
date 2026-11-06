/**
 * Runtime check of the BROWSER code path.
 *
 * This is built with the same vite.config.ts (so the crypto/assert/ws shims and
 * the `process.browser` define all apply), then executed. If radiantjs silently
 * fell back to a broken hasher or a non-CSPRNG, the derived address or the
 * serialised transaction would differ / throw.
 *
 * Expected address for the standard BIP39 test vector at m/44'/512'/0'/0/0:
 *   18qiat9Kff5niCcincht6efD8HhFfzL1AJ
 */
import { HDWallet, p2pkhScript, radiantjs, rxdToPhotons } from "@radiant-core/sdk";
import {
  buildPayment,
  connect,
  crossCheckTip,
  scanWallet,
  MAX_TIP_DRIFT,
} from "../src/lib/wallet";
import { formatRxd, parseRxd } from "../src/lib/money";
import type { ScanResult } from "../src/lib/wallet";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  OK  " : "  FAIL"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

// 1. Deterministic derivation through the browser hasher.
const wallet = HDWallet.fromMnemonic(MNEMONIC, { network: "mainnet" });
const k0 = wallet.deriveKey(0);
check("derivation path", k0.path === "m/44'/512'/0'/0/0", k0.path);
check(
  "known test-vector address",
  k0.address === "18qiat9Kff5niCcincht6efD8HhFfzL1AJ",
  k0.address,
);

// 2. CSPRNG (Web Crypto path) — must produce a fresh 12-word mnemonic.
const generated = HDWallet.generateMnemonic();
check("generateMnemonic → 12 words", generated.split(" ").length === 12);
check("generated mnemonic is different", generated !== MNEMONIC);
const restored = HDWallet.fromMnemonic(generated, { network: "mainnet" });
const restoredAddr = restored.deriveKey(0).address;
// Mainnet P2PKH addresses are base58 "1..." and 26–35 chars (33 or 34 typical).
check(
  "generated mnemonic restores to a valid address",
  /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(restoredAddr) &&
    p2pkhScript(restoredAddr).startsWith("76a914"),
  restoredAddr,
);

// 3. Money helpers (no float drift).
check("1 RXD = 1e8 photons", rxdToPhotons("1") === 100_000_000n);
check("parse/format round-trip", formatRxd(parseRxd("12.3456789"), 8) === "12.3456789");
check("formatRxd trims zeros", formatRxd(parseRxd("1.50000000")) === "1.5");
let rejected = false;
try {
  parseRxd("1.123456789");
} catch {
  rejected = true;
}
check("rejects >8 decimals", rejected);

// 4. Sign a transaction end-to-end (this exercises BufferWriter + assert).
const scan: ScanResult = {
  addresses: [{ key: k0, used: true, change: 0 }],
  utxos: [
    {
      txid: "a1".repeat(32),
      vout: 0,
      value: rxdToPhotons("1"),
      script: p2pkhScript(k0.address),
      height: 400_000,
      ownerAddress: k0.address,
      ownerWif: k0.wif,
      ownerIndex: 0,
      ownerChange: 0,
    },
  ],
  confirmed: rxdToPhotons("1"),
  unconfirmed: 0n,
  total: rxdToPhotons("1"),
  tokenUtxoCount: 0,
  nextReceive: k0,
  nextChange: wallet.deriveKey(0, 1),
};

const plan = buildPayment({
  scan,
  to: wallet.deriveKey(5).address,
  amount: rxdToPhotons("0.25"),
  network: "mainnet",
});
check("txid is 64 hex chars", /^[0-9a-f]{64}$/.test(plan.txid), plan.txid);
// 245-byte tx at the 10,000 photons/byte floor ≈ 2.45M photons (0.0245 RXD).
check(
  "fee is positive and proportionate",
  plan.fee > 0n && plan.fee < rxdToPhotons("0.1"),
  `${plan.fee} photons`,
);
check(
  "fee covers the byte size at the requested rate",
  plan.fee >= BigInt(Math.ceil(plan.hex.length / 2)) * 10_000n,
  `${plan.hex.length / 2} bytes`,
);

const tx = new radiantjs.Transaction(plan.hex);
check("re-decodes to 1 input / 2 outputs", tx.inputs.length === 1 && tx.outputs.length === 2);
const sigHex = tx.inputs[0].script.chunks[0]?.buf
  ? Buffer.from(tx.inputs[0].script.chunks[0].buf).toString("hex")
  : "";
check("sighash byte is 0x41 (ALL|FORKID)", sigHex.slice(-2) === "41", "0x" + sigHex.slice(-2));
const pubHex = tx.inputs[0].script.chunks[1]?.buf
  ? Buffer.from(tx.inputs[0].script.chunks[1].buf).toString("hex")
  : "";
check("signing pubkey is ours", pubHex === k0.publicKey);

// 5. Optional live integration: exercise the app's OWN networking code
//    (`connect` failover + `scanWallet` gap-limit discovery) against mainnet.
if (process.argv.includes("--live")) {
  console.log("\n[live] connecting via src/lib/wallet.connect()…");
  const started = Date.now();
  const { client, endpoint } = await connect("mainnet", undefined, (url) =>
    console.log("       trying " + url),
  );
  check("connect() reached a server", !!endpoint, endpoint);
  check("connect() latched in < 20s", Date.now() - started < 20_000, `${Date.now() - started}ms`);

  const watch = wallet.deriveKey(0);
  const balance = await client.getBalance(watch.address);
  check(
    "getBalance round-trip",
    typeof balance.confirmed === "bigint",
    `${formatRxd(balance.confirmed)} RXD`,
  );

  const tip = await client.request<{ height: number }>("blockchain.headers.subscribe");
  check("chain tip is a real height", (tip?.height ?? 0) > 0, `height ${tip?.height}`);

  const scan = await scanWallet(client, wallet);
  check(
    "scanWallet() completed gap-limit discovery",
    scan.addresses.length >= 40 && typeof scan.total === "bigint",
    `${scan.addresses.length} addresses, ${scan.utxos.length} utxos`,
  );

  // The USD price path, against the real public API (not a stub).
  const { fetchRxdUsd, formatUsdPrice } = await import("../src/lib/price");
  const livePrice = await fetchRxdUsd({ force: true });
  check(
    "live: RXD/USD price fetched from the public API",
    (livePrice?.usd ?? 0) > 0,
    `${livePrice?.source} ${formatUsdPrice(livePrice?.usd ?? 0)} per RXD`,
  );

  // Push updates are only possible if the server implements scripthash
  // subscriptions. If it does not, the backstop poll is what keeps the balance
  // current — so this is worth knowing rather than assuming.
  let pushOk = false;
  let pushDetail = "";
  try {
    const status = await client.subscribe(wallet.deriveKey(0).address, () => {});
    pushOk = true;
    pushDetail = `status ${String(status).slice(0, 12) || "(null)"}`;
  } catch (e) {
    pushDetail = (e as Error).message;
  }
  check("live: server accepts push subscriptions", pushOk, pushDetail);

  // The transaction link we hand to the OS must point at a live explorer: the
  // obvious choices are not all reachable (explorer.radiantblockchain.org, the
  // Photonic default, times out from here).
  const exProbe = await import("../src/lib/explorer");
  const probeUrl = exProbe.explorerTxUrl("0".repeat(63) + "1");
  let explorerOk = false;
  let explorerDetail = "";
  try {
    const res = await fetch(probeUrl as string);
    explorerOk = res.ok;
    explorerDetail = `HTTP ${res.status} · ${new URL(probeUrl as string).host}`;
  } catch (e) {
    explorerDetail = (e as Error).message;
  }
  check("live: block explorer answers a /tx/ link", explorerOk, explorerDetail);

  // MEDIUM-2: independent tip cross-check.
  const primaryTip = await client.request<{ height: number }>(
    "blockchain.headers.subscribe",
  );
  const other = await crossCheckTip("mainnet", endpoint);
  if (other) {
    const drift = Math.abs((primaryTip?.height ?? 0) - other.height);
    check(
      "independent operator agrees on the chain tip",
      drift <= MAX_TIP_DRIFT,
      `${endpoint.replace("wss://", "")}=${primaryTip?.height} vs ${other.operator}=${other.height} (drift ${drift})`,
    );
  } else {
    console.log("       (no independent server reachable — cross-check skipped)");
  }

  client.close();
}

// 6. History: direction, confirmation math and fee, against synthetic txs.
//    A stub client serves pre-built real transactions, so this exercises the
//    actual parser + prevout resolution without touching the network.
{
  const { loadHistory, headerTime } = await import("../src/lib/history");
  const { p2pkhScript: p2pkh, buildTx } = await import("@radiant-core/sdk");

  // A second, foreign wallet to act as the counterparty.
  const foreign = HDWallet.fromMnemonic(
    "legal winner thank year wave sausage worth useful legal winner thank yellow",
    { network: "mainnet" },
  );
  const foreignKey = foreign.deriveKey(0);

  const ours = wallet.deriveKey(0);
  const change = wallet.deriveKey(0, 1);

  // tx1: foreign -> us, 1 RXD.  (a receive)
  const funding = buildTx({
    address: foreignKey.address,
    wif: foreignKey.wif,
    inputs: [
      {
        txid: "ab".repeat(32),
        vout: 0,
        value: rxdToPhotons("2"),
        script: p2pkh(foreignKey.address),
      },
    ],
    outputs: [{ script: p2pkh(ours.address), value: rxdToPhotons("1") }],
    feeRate: 10_000n,
    network: "mainnet",
  });

  // tx2: us -> foreign, 0.5 RXD.  (a send; change returns to us)
  const spend = buildTx({
    address: change.address,
    wif: ours.wif,
    inputs: [
      {
        txid: funding.txid,
        vout: 0,
        value: rxdToPhotons("1"),
        script: p2pkh(ours.address),
      },
    ],
    outputs: [{ script: p2pkh(foreignKey.address), value: rxdToPhotons("0.5") }],
    feeRate: 10_000n,
    network: "mainnet",
  });

  const tip = 105;
  // 80-byte header with timestamp 1700000000 at byte offset 68.
  const ts = 1_700_000_000;
  const tsLe = Buffer.alloc(4);
  tsLe.writeUInt32LE(ts, 0);
  const header =
    "00".repeat(68) + tsLe.toString("hex") + "ffff7f20" + "00000000";

  check("headerTime parses block time", headerTime(header) === ts, String(ts));

  const stub = {
    getHistory: async (addr: string) =>
      addr === ours.address
        ? [
            { tx_hash: funding.txid, height: 100 },
            { tx_hash: spend.txid, height: 101 },
          ]
        : [],
    getTransaction: async (txid: string) => {
      if (txid === funding.txid) return funding.hex;
      if (txid === spend.txid) return spend.hex;
      throw new Error("unknown tx " + txid);
    },
    request: async (method: string, ...params: unknown[]) => {
      if (method === "blockchain.headers.subscribe") return { height: tip };
      if (method === "blockchain.block.header") return header;
      throw new Error("unexpected method " + method + " " + params.length);
    },
  } as never;

  const result = await loadHistory(
    stub,
    [
      { key: ours, used: true, change: 0 },
      { key: change, used: true, change: 1 },
    ],
    { limit: 10 },
  );

  check("history returns both txs", result.entries.length === 2, `${result.entries.length}`);
  check("tip height propagated", result.tipHeight === tip, String(result.tipHeight));

  const incoming = result.entries.find((e) => e.txid === funding.txid)!;
  const outgoing = result.entries.find((e) => e.txid === spend.txid)!;

  check(
    "receive detected with correct amount",
    incoming?.direction === "received" && incoming.net === rxdToPhotons("1"),
    `${incoming?.direction} ${incoming?.net}`,
  );
  check(
    "receive confirmations = tip - height + 1",
    incoming?.confirmations === 6,
    String(incoming?.confirmations),
  );
  check(
    "send detected with negative net",
    outgoing?.direction === "sent" && outgoing.net < 0n,
    `${outgoing?.direction} ${outgoing?.net}`,
  );
  check(
    "send confirmations = tip - height + 1",
    outgoing?.confirmations === 5,
    String(outgoing?.confirmations),
  );
  check(
    "fee computed for a fully-owned send",
    typeof outgoing?.fee === "bigint" && outgoing.fee > 0n,
    String(outgoing?.fee),
  );
  check(
    "block time attached",
    incoming?.time === ts && outgoing?.time === ts,
  );
}

// 7. Session policy: how long an unlock survives closing the popup.
//    A tampered or unrecognised value must not silently grant a long session —
//    the same reasoning as the Android build's auto-lock policy, but the mechanism
//    is different: the popup is destroyed rather than backgrounded, so the unlock
//    is bounded by a timestamp instead of a visibility listener.
{
  const session = await import("../src/lib/session");

  check(
    "missing unlock timeout falls back to the default",
    session.parseUnlockTimeoutMs(null) === session.DEFAULT_UNLOCK_TIMEOUT_MS,
  );
  check(
    "garbage unlock timeout falls back to the default",
    session.parseUnlockTimeoutMs("soon") === session.DEFAULT_UNLOCK_TIMEOUT_MS &&
      session.parseUnlockTimeoutMs("-1") === session.DEFAULT_UNLOCK_TIMEOUT_MS,
  );
  check(
    "an offered unlock timeout is honoured",
    session.parseUnlockTimeoutMs("0") === 0 &&
      session.parseUnlockTimeoutMs(String(60_000)) === 60_000,
  );

  session.saveUnlockTimeoutMs(15 * 60_000);
  check(
    "unlock timeout round-trips through storage",
    session.loadUnlockTimeoutMs() === 15 * 60_000,
    String(session.loadUnlockTimeoutMs()),
  );

  const secrets = {
    mnemonic: "test test test",
    network: "mainnet",
    server: "",
    label: "t",
    createdAt: 1,
  } as never;

  await session.saveSession(secrets, 60_000);
  check("a live session is restored", (await session.loadSession()) !== null);

  await session.saveSession(secrets, 0);
  check(
    "a zero timeout stores nothing (lock immediately)",
    (await session.loadSession()) === null,
  );

  await session.saveSession(secrets, 1);
  await new Promise((r) => setTimeout(r, 10));
  check("an expired session is refused", (await session.loadSession()) === null);

  await session.saveSession(secrets, 60_000);
  await session.clearSession();
  check("clearing drops the session", (await session.loadSession()) === null);
}

// 8. Vault policy + KDF upgrade (security report MEDIUM-1 / L4).
//    Runs against the real storage module + real WebCrypto, so this exercises the
//    actual encrypt/decrypt/upgrade path rather than a mock. storage.ts falls back
//    to an in-memory mirror outside an extension, which is exactly what a test
//    wants — but that means the fixture has to be written through it, not to a
//    localStorage stub (nothing reads localStorage any more).
{
  const store = await import("../src/lib/storage");
  store.hydrate();

  const vault = await import("../src/lib/vault");
  const secrets = {
    mnemonic: "test test test",
    network: "mainnet" as const,
    server: "",
    label: "t",
    createdAt: 1,
  };

  check("6-char passphrase rejected by policy", vault.checkPassphrase("abc123") !== null);
  check(
    "12-char passphrase accepted",
    vault.checkPassphrase("correct horse battery") === null,
  );
  check(
    "repetitive passphrase rejected",
    vault.checkPassphrase("aaaaaaaaaaaaaaaa") !== null,
  );

  let policyEnforced = false;
  try {
    await vault.saveVault("abc123", secrets);
  } catch {
    policyEnforced = true;
  }
  check("saveVault enforces the policy", policyEnforced);

  await vault.saveVault("correct horse battery", secrets);
  const meta = vault.readVaultMeta();
  check("new vault uses 600k iterations", meta?.iterations === 600_000, String(meta?.iterations));
  check("new vault is schema 2", meta?.schema === 2, String(meta?.schema));
  check(
    "vault round-trips",
    (await vault.unlockVault("correct horse battery")).mnemonic === secrets.mnemonic,
  );

  // Hand-build a LEGACY vault: schema 1, 310k iterations, 6-char passphrase.
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode("oldpass1"),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const oldKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310_000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const oldCt = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    oldKey,
    enc.encode(JSON.stringify(secrets)),
  );
  const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
  store.setItem(
    "rxd.wallet.vault.v1",
    JSON.stringify({
      v: 1,
      kdf: "PBKDF2-SHA256",
      iterations: 310_000,
      salt: b64(salt),
      iv: b64(iv),
      ct: b64(new Uint8Array(oldCt)),
      createdAt: 1,
    }),
  );

  check("legacy vault reported as needing upgrade", vault.needsKdfUpgrade());
  check(
    "legacy 6-char passphrase still unlocks",
    (await vault.unlockVault("oldpass1")).mnemonic === secrets.mnemonic,
  );
  const upgraded = vault.readVaultMeta();
  check(
    "legacy vault auto-upgraded to 600k / schema 2",
    upgraded?.iterations === 600_000 && upgraded?.schema === 2,
    `${upgraded?.iterations}/${upgraded?.schema}`,
  );
  check(
    "upgraded vault still opens with the same passphrase",
    (await vault.unlockVault("oldpass1")).mnemonic === secrets.mnemonic,
  );

  // Tampered KDF parameters must be refused, not honoured.
  const tampered = JSON.parse(store.getItem("rxd.wallet.vault.v1")!);
  tampered.iterations = 1_000;
  store.setItem("rxd.wallet.vault.v1", JSON.stringify(tampered));
  let tamperRejected = false;
  try {
    await vault.unlockVault("oldpass1");
  } catch {
    tamperRejected = true;
  }
  check("absurd stored iteration count rejected", tamperRejected);
}

// 9. Step-up authentication before spending.
//    The failure mode worth asserting is a payment being authorised with a secret
//    that does not belong to the wallet on screen.
{
  const vault = await import("../src/lib/vault");
  const reauth = await import("../src/lib/reauth");

  const mine: vault.WalletSecrets = {
    mnemonic: "test test test",
    network: "mainnet",
    server: "",
    label: "t",
    createdAt: 1,
  };
  // Section 8 left a deliberately tampered vault behind.
  await vault.saveVault("correct horse battery", mine);

  let confirmed = true;
  try {
    await reauth.confirmWithPassphrase("correct horse battery", mine);
  } catch {
    confirmed = false;
  }
  check("passphrase confirms the wallet on screen", confirmed);

  let wrongPassphraseRejected = false;
  try {
    await reauth.confirmWithPassphrase("wrong horse battery", mine);
  } catch {
    wrongPassphraseRejected = true;
  }
  check("wrong passphrase cannot authorise a payment", wrongPassphraseRejected);

  let foreignWalletRejected = false;
  try {
    await reauth.confirmWithPassphrase("correct horse battery", {
      ...mine,
      mnemonic: "other words entirely here",
    });
  } catch {
    foreignWalletRejected = true;
  }
  check(
    "a secret belonging to another wallet is refused",
    foreignWalletRejected,
  );
}

// 9. Connection failure handling (security of expectations: fail fast, say why).
{
  const walletLib = await import("../src/lib/wallet");
  const servers = await import("../src/lib/servers");

  const verified = servers.SERVERS.mainnet
    .filter((s) => s.verified)
    .map((s) => s.url);
  const auto = servers.autoCandidates("mainnet");
  check(
    "auto-connect tries only verified endpoints",
    auto.length === verified.length && auto.every((u) => verified.includes(u)),
    `${auto.length} endpoint(s): ${auto.map((u) => u.replace("wss://", "")).join(", ")}`,
  );
  check(
    "the dead hosts are still listed for manual selection",
    servers.SERVERS.mainnet.length > verified.length,
    `${servers.SERVERS.mainnet.length} known, ${verified.length} auto`,
  );

  // Unreachable endpoints must fail fast rather than hang.
  const started = Date.now();
  let message = "";
  try {
    await walletLib.connect("mainnet", undefined, undefined, {
      candidates: ["wss://127.0.0.1:9", "wss://127.0.0.1:10"],
      budgetMs: 6_000,
      connectTimeoutMs: 3_000,
    });
  } catch (e) {
    message = (e as Error).message;
  }
  const elapsed = Date.now() - started;
  check("dead endpoints give up inside the budget", elapsed < 7_000, `${elapsed}ms`);
  check("failure names the hosts that were tried", /127\.0\.0\.1/.test(message));
  check(
    "failure suggests a cause a user can act on",
    /connection may be down/.test(message),
    JSON.stringify(message.split("\n")[0]),
  );

  // A blackholed host (packets dropped) is the case the user actually hit: no
  // refusal, just silence. Verify the per-attempt timeout and the overall budget
  // bound it, instead of the old ~70s of trying every dead host in turn.
  const silent = Date.now();
  let silentMessage = "";
  try {
    await walletLib.connect("mainnet", undefined, undefined, {
      // TEST-NET-1: reserved, never routed, so connections hang rather than fail.
      candidates: [
        "wss://192.0.2.1:50022",
        "wss://192.0.2.2:50022",
        "wss://192.0.2.3:50022",
      ],
      budgetMs: 5_000,
      connectTimeoutMs: 2_000,
    });
  } catch (e) {
    silentMessage = (e as Error).message;
  }
  const silentElapsed = Date.now() - silent;
  check(
    "blackholed hosts are bounded by the budget",
    silentElapsed < 7_000,
    `${silentElapsed}ms for 3 unreachable hosts, 5s budget`,
  );
  check(
    "unattempted hosts are reported as skipped",
    /out of time/.test(silentMessage) || /timed out/.test(silentMessage),
    JSON.stringify(silentMessage.split("\n").slice(3).join(" | ").slice(0, 120)),
  );

  // Offline should be reported as offline, not as "server down".
  let stubbed = false;
  try {
    Object.defineProperty(globalThis.navigator, "onLine", {
      value: false,
      configurable: true,
    });
    stubbed = true;
  } catch {
    /* read-only in this runtime */
  }
  if (stubbed) {
    const offlineMsg = walletLib.connectFailureMessage("mainnet", []);
    check("offline is reported as offline", /offline/i.test(offlineMsg), offlineMsg);
  } else {
    console.log("       (navigator.onLine not stubbable here — offline case skipped)");
  }
}

// 12. USD price: formatting, caching and graceful failure.
{
  const price = await import("../src/lib/price");

  // RXD trades in fractions of a cent, so small amounts must not look like
  // rounding noise.
  check(
    "fiat below a cent reads '< $0.01'",
    price.formatUsdBalance(100_000_000n, 0.0000286) === "< $0.01",
    price.formatUsdBalance(100_000_000n, 0.0000286),
  );
  check("zero balance reads '$0.00'", price.formatUsdBalance(0n, 0.0000286) === "$0.00");
  check(
    "ordinary amount reads as dollars",
    price.formatUsdBalance(10_000_000_000n, 2.5) === "$250.00",
    price.formatUsdBalance(10_000_000_000n, 2.5),
  );
  check("unit price keeps significant digits", price.formatUsdPrice(0.00002862) === "$0.0000286", price.formatUsdPrice(0.00002862));
  check("unit price for a 'normal' coin", price.formatUsdPrice(12.5) === "$12.50");
  check("no price, no string", price.formatUsdPrice(0) === "");

  // Cache + fallback, with a stubbed fetch. Storage is the real module's
  // in-memory mirror, so reset it to start from a cold cache.
  const priceStore = await import("../src/lib/storage");
  priceStore.removeItem("rxd.price.usd");

  let calls = 0;
  const goodFetch = (async (url: string) => {
    calls++;
    return {
      ok: true,
      json: async () =>
        String(url).includes("coingecko")
          ? { radiant: { usd: 0.00003 } }
          : { quotes: { USD: { price: 0.00004 } } },
    };
  }) as unknown as typeof fetch;

  const first = await price.fetchRxdUsd({ fetchImpl: goodFetch, now: 1_000 });
  check(
    "fetches a price and names the source",
    first?.usd === 0.00003 && first?.source === "coingecko" && !first?.stale,
    `${first?.source} ${first?.usd}`,
  );

  const cached = await price.fetchRxdUsd({ fetchImpl: goodFetch, now: 1_000 + 30_000 });
  check("reuses the cache inside the TTL", calls === 1 && cached?.usd === 0.00003, `${calls} request(s)`);

  await price.fetchRxdUsd({ fetchImpl: goodFetch, now: 1_000 + 10 * 60_000 });
  check("refetches once the TTL expires", calls === 2, `${calls} request(s)`);

  const offlineFetch = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  const stale = await price.fetchRxdUsd({ fetchImpl: offlineFetch, now: 1_000 + 20 * 60_000 });
  check(
    "offline falls back to the cached price, marked stale",
    stale?.usd === 0.00003 && stale?.stale === true,
    `stale=${stale?.stale}`,
  );

  priceStore.removeItem("rxd.price.usd");
  const nothing = await price.fetchRxdUsd({ fetchImpl: offlineFetch, now: 5_000 });
  check("returns null (not a throw) when nothing is available", nothing === null);
}

// 13. Live balance updates: what gets watched, debouncing, and teardown.
{
  const live = await import("../src/lib/liveUpdates");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Fixture: two addresses with history, then unused ones.
  const addr = (address: string, used: boolean) =>
    ({ key: { address } as never, used, change: 0 });

  const addresses = [
    addr("used0", true),
    addr("used1", true),
    addr("unused0", false),
    addr("unused1", false),
    addr("unused2", false),
    addr("unused3", false),
  ];

  check(
    "watches used addresses plus a lookahead",
    JSON.stringify(live.watchTargets(addresses, 3)) ===
      JSON.stringify(["used0", "used1", "unused0", "unused1", "unused2"]),
    live.watchTargets(addresses, 3).join(","),
  );

  function makeFake() {
    const listeners = new Map<string, (s: string | null) => void>();
    const unsubscribed: string[] = [];
    const refuse = new Set<string>();
    return {
      listeners,
      unsubscribed,
      refuse,
      subscribe: async (a: string, cb: (s: string | null) => void) => {
        if (refuse.has(a)) throw new Error("refused");
        listeners.set(a, cb);
        return "status";
      },
      unsubscribe: async (a: string) => {
        unsubscribed.push(a);
        listeners.delete(a);
        return true;
      },
      emit: (a: string) => listeners.get(a)?.("changed"),
    };
  }

  const fake = makeFake();
  let changes = 0;
  const handle = await live.watchWalletAddresses(
    fake as never,
    addresses,
    () => {
      changes++;
    },
    { lookahead: 3, debounceMs: 40, settleMs: 60 },
  );
  check("subscribes to every target", handle.subscribed.length === 5, `${handle.subscribed.length}`);
  check("nothing was refused", handle.failed.length === 0);

  // The subscription's own echo must not trigger a scan (that was the loop risk).
  fake.emit("used0");
  await sleep(90);
  check("ignores notifications inside the settle window", changes === 0, `${changes} change(s)`);

  await sleep(80);
  fake.emit("used0");
  fake.emit("used1");
  fake.emit("unused0");
  await sleep(140);
  check("coalesces a burst into one re-scan", changes === 1, `${changes} change(s)`);

  await handle.dispose();
  check(
    "dispose unsubscribes everything",
    fake.unsubscribed.length === 5,
    `${fake.unsubscribed.length} unsubscribed`,
  );
  fake.emit("used0");
  await sleep(140);
  check("no callbacks after dispose", changes === 1, `${changes} change(s)`);

  // A server that caps subscriptions must not break the rest.
  const picky = makeFake();
  picky.refuse.add("unused0");
  const handle2 = await live.watchWalletAddresses(
    picky as never,
    addresses,
    () => {},
    { lookahead: 3, settleMs: 0 },
  );
  check(
    "a refused subscription is reported, not fatal",
    handle2.failed.length === 1 && handle2.subscribed.length === 4,
    `${handle2.subscribed.length} ok / ${handle2.failed.length} refused`,
  );
  await handle2.dispose();
}

// 14. Block explorer links for a tapped transaction.
{
  const ex = await import("../src/lib/explorer");
  const txid = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const expected = `https://radiantexplorer.com/tx/${txid}`;

  check("builds a /tx/ link", ex.explorerTxUrl(txid) === expected, ex.explorerTxUrl(txid) ?? "null");
  check(
    "normalises an uppercase txid",
    ex.explorerTxUrl(txid.toUpperCase()) === expected,
  );
  check("trims surrounding whitespace", ex.explorerTxUrl(`  ${txid}  `) === expected);
  check("rejects a truncated id", ex.explorerTxUrl("abc123") === null);
  check("rejects non-hex characters", ex.explorerTxUrl("z".repeat(64)) === null);
  check("rejects an empty value", ex.explorerTxUrl("") === null);
  check(
    "always https (the native plugin refuses anything else)",
    (ex.explorerTxUrl(txid) ?? "").startsWith("https://"),
  );
}

// 15. SPV: header proof of work, chain linkage and merkle inclusion.
//     Fixtures below are real mainnet data, captured with scripts/_spv-probe.mjs.
//     The hash choices are the point: Radiant hashes blocks with SHA-512/256 but
//     transaction ids and merkle nodes with SHA-256, so a Bitcoin-shaped verifier
//     rejects every real header while a SHA-512-shaped one accepts forged merkle
//     proofs. Both directions are asserted.
{
  const spv = await import("../src/lib/spv");

  const HEADER_479445 =
    "00000020b6c93e7d8b2aa02876111150c9655762229147b5b0b069013301000000000000" +
    "b032a62207f2cf563300c798a22bacc1d167093ce277afcfae9722ea88b811426a04ee6a" +
    "6076011a2167b6ee";
  const MERKLE_479445 =
    "4211b888ea2297aecfaf77e23c0967d1c1ac2ba298c7003356cff20722a632b0";
  const TXID = "84066739235c82f2f79dbf5e0471e1c1406cbada54e75c6b998ed267acf1f1e7";
  const BRANCH = [
    "66ca055ba5b581bd853f9398672ba2435198067e5d6a1c6855c12ca38a43a9a4",
    "ed45f0c076217cd82b792493388181735ed92e82d45e0e1680c1f2a994b9ed94",
    "fa812148a84ede6b5b94c8731c6899076abe591e4edead88c2880e1d0c49fe18",
    "efc53d9e0714e2088c17d988dfd7fedd423edb04c7af47478c434d80b6899911",
    "8946f954716bb2a9953af537312768547f739e8a11743d587c60f8219e907190",
    "4d14f3f48aeb6dd8fb18fb98e77a48ef8c1b57b9dcd1c574fa8d1975b13085da",
  ];

  const header = spv.parseHeader(HEADER_479445, 479445);
  check(
    "header hashes with SHA-512/256d",
    header.hash === "00000000000000f453716d93ed7880cad423b32446885813fceee3422dcb4cd5",
    header.hash,
  );
  check("header prev/parent decoded", header.prev === "00000000000001330169b0b0b5479122625765c95011117628a02a8b7d3ec9b6");
  check("header merkle root decoded", header.merkleRoot === MERKLE_479445);
  check("header bits decoded", header.bits === 0x1a017660, "0x" + header.bits.toString(16));
  check("real header meets its target", header.meetsTarget);

  // Flipping one nonce byte must break the proof — otherwise the check is vacuous.
  const tampered =
    HEADER_479445.slice(0, 152) +
    (HEADER_479445.slice(152, 154) === "00" ? "01" : "00") +
    HEADER_479445.slice(154);
  check(
    "a tampered header fails proof of work",
    spv.parseHeader(tampered, 479445).meetsTarget === false,
  );

  check(
    "target expands the compact bits field",
    spv.targetFromBits(0x1a017660) === 0x017660n * 2n ** 184n,
  );

  const root = await spv.merkleRootFromProof(TXID, BRANCH, 0);
  check("merkle proof reproduces the header root", root === MERKLE_479445, root.slice(0, 24) + "…");

  const corrupted = [...BRANCH];
  corrupted[3] = corrupted[3].replace(/^./, (c) => (c === "0" ? "1" : "0"));
  check(
    "a corrupted merkle branch is rejected",
    (await spv.merkleRootFromProof(TXID, corrupted, 0)) !== MERKLE_479445,
  );
}

// 16. SPV against the live chain.
{
  const spv = await import("../src/lib/spv");
  const walletLib = await import("../src/lib/wallet");

  let chainOk = false;
  try {
    const { client } = await walletLib.connect("mainnet");
    try {
      const chain = await spv.syncChain(client);
      chainOk = chain.ok;
      check(
        "connects and verifies headers from the pinned checkpoint",
        chain.ok,
        chain.ok ? `${chain.checked} header(s), tip ${chain.tip}` : chain.reason,
      );
      if (chain.ok) {
        check(
          "verified tip matches the server's tip",
          chain.tip === (await client.request<{ height: number }>("blockchain.headers.subscribe")).height,
          String(chain.tip),
        );
      }
    } finally {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    check("connects and verifies headers from the pinned checkpoint", false, (e as Error).message);
  }

  if (chainOk) {
    // One more connection for the merkle and txid checks (state is cheap, sockets
    // are not: the previous one is closed by now).
    const { client } = await walletLib.connect("mainnet");
    try {
      const chain = await spv.syncChain(client);
      const txid = await client.request<string>(
        "blockchain.transaction.id_from_pos",
        chain.tip,
        0,
        false,
      );

      const proof = await spv.verifyTransaction(client, txid, chain.tip, chain.merkleRoots);
      check("live transaction inclusion proof verifies", proof.verified, proof.reason || txid.slice(0, 16) + "…");

      const bogus = cand_txid(txid);
      const badProof = await spv.verifyTransaction(client, bogus, chain.tip, chain.merkleRoots);
      check("a wrong transaction id fails its proof", badProof.verified === false);

      const raw = await client.request<string>("blockchain.transaction.get", txid, false);
      check("txid is the double-SHA-256 of the body", await spv.verifyTxid(raw, txid));
      check(
        "a tampered body no longer matches its txid",
        (await spv.verifyTxid(raw.replace(/^../, "ff"), txid)) === false,
      );
    } finally {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
  }

  // A digest that is definitely not a transaction in that block.
  function cand_txid(txid: string): string {
    return (txid[0] === "0" ? "1" : "0") + txid.slice(1);
  }
}


console.log(`\n${failures === 0 ? "ALL BROWSER-PATH CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);

