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
  // The curated list was synced to the Android build (1.0.13): every listed host
  // now answers, so there is no "dead but selectable" tier left. What matters is
  // that nothing listed is un-provable and that quorum still has two operators.
  const hostOf = (url: string) => url.replace(/^wss:\/\//, "").split(":")[0];
  check(
    "every endpoint is wss:// on a hostname, never a bare IP",
    servers.SERVERS.mainnet.every(
      (s) =>
        s.url.startsWith("wss://") &&
        !/^\d{1,3}(\.\d{1,3}){3}$/.test(hostOf(s.url)),
    ),
    servers.SERVERS.mainnet.map((s) => hostOf(s.url)).join(", "),
  );

  // The tip cross-check only proves anything across *distinct* operators, so a
  // list that has collapsed to one administrator has quietly lost quorum.
  const operators = new Set(servers.SERVERS.mainnet.map((s) => s.operator));
  check(
    "at least two distinct operators remain for the tip cross-check",
    operators.size >= 2,
    `${servers.SERVERS.mainnet.length} known, ${operators.size} operator(s): ${[
      ...operators,
    ].join(", ")}`,
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
// 17. Background watch list: the only thing the extension lets the background know.
//     It must contain public data only, and a corrupted entry must never be trusted
//     into a connection.
{
  const watch = await import("../src/lib/watchList");
  const sdk = await import("@radiant-core/sdk");

  // A real mainnet address, because buildWatchList derives scripthashes through the
  // SDK, which validates the base58 checksum.
  const ADDRESS = "18qiat9Kff5niCcincht6efD8HhFfzL1AJ";
  const used = { key: { address: ADDRESS }, used: true } as never;
  const unused = { key: { address: ADDRESS }, used: false } as never;

  const list = watch.buildWatchList("wss://electrumx.radiant4people.com:50022", [
    used,
    unused,
    unused,
    unused,
  ]);
  check("watch list covers used plus a lookahead", list.addresses.length === 4, String(list.addresses.length));
  check(
    "watch list holds scripthashes, not addresses-with-keys",
    list.scripthashes.length === 4 &&
      list.scripthashes.every((s) => /^[0-9a-f]{64}$/i.test(s)),
  );
  check(
    "scripthashes match the SDK's derivation",
    list.scripthashes[0] === sdk.addressToScriptHash(ADDRESS, "mainnet"),
    list.scripthashes[0]?.slice(0, 16) + "…",
  );
  check(
    "the watch list carries no secret",
    !JSON.stringify(list).toLowerCase().includes("mnemonic"),
  );

  watch.saveWatchList(list);
  const restored = watch.loadWatchList();
  check(
    "watch list round-trips through storage",
    restored?.endpoint === list.endpoint &&
      restored?.scripthashes.join(",") === list.scripthashes.join(","),
  );

  // Corrupt or hostile entries must be refused, not connected to.
  const store = await import("../src/lib/storage");
  store.setItem("rxd.watch.list", "{not json");
  check("malformed watch list rejected", watch.loadWatchList() === null);
  store.setItem(
    "rxd.watch.list",
    JSON.stringify({ endpoint: "ws://insecure.example", scripthashes: ["00".repeat(32)] }),
  );
  check("non-wss endpoint rejected", watch.loadWatchList() === null);
  store.setItem(
    "rxd.watch.list",
    JSON.stringify({ endpoint: "wss://ok.example:50022", scripthashes: ["nothex"] }),
  );
  check("non-hex scripthash rejected", watch.loadWatchList() === null);

  watch.clearWatchList();
  check("clearing removes the watch list", watch.loadWatchList() === null);

  check("background watching defaults to on", watch.loadWatchEnabled() === true);
  watch.saveWatchEnabled(false);
  check("watching can be turned off", watch.loadWatchEnabled() === false);
  watch.saveWatchEnabled(true);
}




// 18. Server list management (Android 1.0.13) and the SPV proof summary
//     (Android 1.0.12), ported with the same expectations so the two clients
//     cannot drift apart silently. Storage here is chrome.storage's in-memory
//     mirror - there is no chrome API under Node - so these are logic checks.
{
  const servers = await import("../src/lib/servers");
  const spv = await import("../src/lib/spv");
  const store = await import("../src/lib/storage");

  const parsedUrl = (raw: string) => {
    const result = servers.parseServerUrl(raw);
    return "url" in result ? result.url : null;
  };
  const parseError = (raw: string) => {
    const result = servers.parseServerUrl(raw);
    return "error" in result ? result.error : "";
  };

  check(
    "a bare host is assumed to be wss://",
    parsedUrl("electrumx.example.org:50022") ===
      "wss://electrumx.example.org:50022",
    String(parsedUrl("electrumx.example.org:50022")),
  );
  check(
    "case, padding and a trailing slash normalise away",
    parsedUrl("  WSS://ElectrumX.Example.ORG:50022/  ") ===
      "wss://electrumx.example.org:50022",
  );
  check(
    "the wss default port normalises away, so duplicates still match",
    parsedUrl("wss://electrumx.example.org:443") === "wss://electrumx.example.org",
  );
  check(
    "bare ws:// is refused (an extension page blocks it as mixed content)",
    parseError("ws://electrumx.example.org:50012").includes("wss://"),
  );
  check("http:// is refused", parseError("http://electrumx.example.org") !== "");
  check("an empty field is refused", parseError("   ") !== "");
  check(
    "a path is refused",
    parseError("wss://host.example.org:50022/electrum") !== "",
  );
  check(
    "credentials are refused",
    parseError("wss://user:pw@host.example.org:50022") !== "",
  );
  check(
    "an out-of-range port is refused",
    parseError("wss://host.example.org:70000") !== "",
  );
  check("junk is refused", parseError("wss://%%%") !== "");

  const curated = servers.SERVERS.mainnet.map((s) => s.url);
  const custom = "wss://electrumx.example.org:50022";
  check(
    "the curated list is the starting point",
    servers.allServers("mainnet").length === curated.length,
    `${servers.allServers("mainnet").length} listed`,
  );

  const added = servers.addCustomServer("mainnet", "electrumx.example.org:50022");
  check(
    "a user-added server is stored, normalised and marked custom",
    added.url === custom && added.custom === true && added.verified === false,
    added.url,
  );
  check(
    "it is listed with its own operator",
    servers.allServers("mainnet").length === curated.length + 1 &&
      servers.findServer("mainnet", custom)?.operator === "electrumx.example.org",
  );
  check(
    "auto-connect still tries curated verified endpoints first",
    servers.autoCandidates("mainnet")[0] === curated[0] &&
      servers.autoCandidates("mainnet").includes(custom),
    servers
      .autoCandidates("mainnet")
      .map((u) => u.replace("wss://", ""))
      .join(", "),
  );

  let duplicateRejected = false;
  try {
    servers.addCustomServer("mainnet", "WSS://ELECTRUMX.example.org:50022");
  } catch {
    duplicateRejected = true;
  }
  check("adding the same host again is refused", duplicateRejected);

  let curatedDuplicateRejected = false;
  try {
    servers.addCustomServer("mainnet", curated[0]);
  } catch {
    curatedDuplicateRejected = true;
  }
  check("a curated endpoint cannot be added a second time", curatedDuplicateRejected);  servers.setCustomServerVerified("mainnet", custom, true);
  check(
    "a passed handshake is remembered",
    servers.findServer("mainnet", custom)?.verified === true,
  );

  servers.removeServer("mainnet", custom);
  check(
    "removing a user-added server deletes it",
    servers.allServers("mainnet").length === curated.length &&
      servers.customServers("mainnet").length === 0,
  );

  servers.removeServer("mainnet", curated[2]);
  check(
    "removing a curated server only hides it",
    servers.allServers("mainnet").length === curated.length - 1 &&
      servers.hiddenServers("mainnet").length === 1 &&
      !servers.autoCandidates("mainnet").includes(curated[2]),
  );

  // Re-adding a hidden curated endpoint as a user server is allowed, but the
  // restored default must not leave an invisible duplicate behind.
  servers.addCustomServer("mainnet", curated[2], { verified: true });
  check(
    "a hidden built-in can be re-added as a user server",
    servers.allServers("mainnet").length === curated.length &&
      servers.findServer("mainnet", curated[2])?.custom === true,
  );

  servers.restoreHiddenServers("mainnet");
  check(
    "built-in servers come back on restore",
    servers.allServers("mainnet").length === curated.length &&
      servers.hiddenServers("mainnet").length === 0,
  );
  check(
    "restoring drops the shadowed duplicate instead of hiding it",
    servers.customServers("mainnet").length === 0 &&
      servers.findServer("mainnet", curated[2])?.custom === undefined,
  );

  servers.setPreferredServer(curated[0]);
  servers.removeServer("mainnet", curated[0]);
  check(
    "removing the active server clears the preference",
    servers.getPreferredServer() === null,
  );
  servers.restoreHiddenServers("mainnet");

  // The last endpoint must survive: a wallet with no server can never connect.
  servers.removeServer("mainnet", curated[1]);
  servers.removeServer("mainnet", curated[2]);
  let lastGuard = "";
  try {
    servers.removeServer("mainnet", curated[0]);
  } catch (e) {
    lastGuard = (e as Error).message;
  }
  check(
    "the last remaining server cannot be removed",
    lastGuard !== "" && servers.allServers("mainnet").length === 1,
    lastGuard || "no error thrown",
  );
  servers.restoreHiddenServers("mainnet");  // Storage is not trusted: an injected ws:// entry must be dropped on read.
  store.setItem(
    "rxd.wallet.customServers.v1",
    JSON.stringify({
      mainnet: [
        { url: "ws://evil.example.org:50012", verified: true },
        { url: "wss://good.example.org:50022", verified: true },
        "junk",
        null,
      ],
    }),
  );
  const revalidated = servers.allServers("mainnet");
  check(
    "stored entries are re-validated on read",
    revalidated.length === curated.length + 1 &&
      revalidated.some((s) => s.url === "wss://good.example.org:50022") &&
      !revalidated.some((s) => s.url.includes("evil")),
    `${revalidated.length} listed`,
  );
  check(
    "a re-validated entry keeps its measured verified flag",
    servers.findServer("mainnet", "wss://good.example.org:50022")?.verified === true,
  );

  // The Home summary must not overstate or alarm: "0 checked" is the state most
  // easily mis-worded, and a failed proof has to read as a shortfall.
  check(
    "summary: nothing checked yet",
    spv.describeProofs(null, 3) === "transactions not proven yet",
    spv.describeProofs(null, 3),
  );
  check(
    "summary: no confirmed transactions",
    spv.describeProofs({ checked: 0, proven: 0 }, 0) ===
      "nothing confirmed to prove yet",
    spv.describeProofs({ checked: 0, proven: 0 }, 0),
  );
  check(
    "summary: confirmed rows but none checked",
    spv.describeProofs({ checked: 0, proven: 0 }, 4) ===
      "transactions not proven yet",
    spv.describeProofs({ checked: 0, proven: 0 }, 4),
  );
  check(
    "summary: all proven",
    spv.describeProofs({ checked: 3, proven: 3 }, 3) ===
      "3 of 3 confirmed transactions proven",
    spv.describeProofs({ checked: 3, proven: 3 }, 3),
  );
  check(
    "summary: one transaction is singular",
    spv.describeProofs({ checked: 1, proven: 1 }, 1) ===
      "1 of 1 confirmed transaction proven",
    spv.describeProofs({ checked: 1, proven: 1 }, 1),
  );
  check(
    "summary: a failed proof shows the shortfall",
    spv.describeProofs({ checked: 4, proven: 2 }, 4) ===
      "2 of 4 confirmed transactions proven",
    spv.describeProofs({ checked: 4, proven: 2 }, 4),
  );
  check(
    "summary: bounded work is disclosed",
    spv.describeProofs({ checked: 8, proven: 8 }, 20).endsWith("(newest 8 checked)"),
    spv.describeProofs({ checked: 8, proven: 8 }, 20),
  );

  // Leave nothing behind for anything that runs after this section.
  store.removeItem("rxd.wallet.customServers.v1");
  store.removeItem("rxd.wallet.hiddenServers.v1");
  store.removeItem("rxd.wallet.preferredServer");
}
console.log(`\n${failures === 0 ? "ALL BROWSER-PATH CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);

