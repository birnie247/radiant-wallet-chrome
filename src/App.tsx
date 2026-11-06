import { useCallback, useEffect, useRef, useState } from "react";
import { HDWallet } from "@radiant-core/sdk";
import { hasVault, unlockVault, type WalletSecrets } from "./lib/vault";
import { connect, crossCheckTip, scanWallet } from "./lib/wallet";
import { getPreferredServer } from "./lib/servers";
import { loadHistory, type HistoryEntry } from "./lib/history";
import { watchWalletAddresses, type WatchHandle } from "./lib/liveUpdates";
import {
  fetchRxdUsd,
  loadFiatEnabled,
  saveFiatEnabled,
  type PriceResult,
} from "./lib/price";
import {
  clearSession,
  loadSession,
  loadUnlockTimeoutMs,
  saveSession,
  saveUnlockTimeoutMs,
} from "./lib/session";
import type { Screen, Session } from "./types";
import {
  syncChain,
  verifyTransaction,
  type ChainResult,
} from "./lib/spv";
import {
  buildWatchList,
  clearWatchList,
  loadWatchEnabled,
  saveWatchEnabled,
  saveWatchList,
} from "./lib/watchList";
import BrandMark from "./components/BrandMark";
import Onboarding from "./screens/Onboarding";
import Unlock from "./screens/Unlock";
import Home from "./screens/Home";
import Receive from "./screens/Receive";
import Send from "./screens/Send";
import Settings from "./screens/Settings";

export default function App() {
  const [booted, setBooted] = useState(false);
  const [hasExisting, setHasExisting] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [busy, setBusy] = useState("");
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [tipDrift, setTipDrift] = useState<number | null>(null);
  /**
   * Result of verifying the header chain (see src/lib/spv.ts). Null until the
   * first attempt finishes; `ok` false carries the reason.
   */
  const [spv, setSpv] = useState<ChainResult | null>(null);

  /** Background watching (offscreen document) is on unless the user opts out. */
  const [watchEnabled, setWatchEnabledState] = useState<boolean>(loadWatchEnabled);

  /**
   * How long an unlock survives the popup being closed. See src/lib/session.ts —
   * this replaces the Android build's background auto-lock, because a popup is
   * destroyed rather than backgrounded.
   */
  const [unlockTimeoutMs, setUnlockTimeoutMsState] = useState<number>(loadUnlockTimeoutMs);

  /** RXD/USD price for display. Null when unavailable or fiat is switched off. */
  const [price, setPrice] = useState<PriceResult | null>(null);
  const [fiatEnabled, setFiatEnabledState] = useState<boolean>(loadFiatEnabled);

  const setFiatEnabled = useCallback((enabled: boolean) => {
    setFiatEnabledState(enabled);
    saveFiatEnabled(enabled);
    // Switching it off must also stop the requests immediately.
    if (!enabled) setPrice(null);
    else void fetchRxdUsd().then(setPrice).catch(() => undefined);
  }, []);

  const hydratePrice = useCallback(async () => {
    if (!fiatEnabled) {
      setPrice(null);
      return;
    }
    // Never throws: a price API being down must not affect the wallet.
    setPrice(await fetchRxdUsd());
  }, [fiatEnabled]);

  const setUnlockTimeoutMs = useCallback((ms: number) => {
    setUnlockTimeoutMsState(ms);
    saveUnlockTimeoutMs(ms);
  }, []);

  /**
   * Hand the public watch list to the background, or take it back.
   *
   * Only an endpoint and scripthashes cross that boundary — never a key — which is
   * what makes it safe for the watcher to keep running while the wallet is locked.
   */
  const armWatcher = useCallback((next: Session | null, enabled: boolean) => {
    const api = (globalThis as { chrome?: typeof chrome }).chrome;
    if (!next || !enabled) {
      clearWatchList();
      void api?.runtime?.sendMessage({ type: "watch:stop" })?.catch(() => undefined);
      return;
    }
    saveWatchList(buildWatchList(next.endpoint, next.scan.addresses));
    void api?.runtime?.sendMessage({ type: "watch:start" })?.catch(() => undefined);
  }, []);

  const setWatchEnabled = useCallback(
    (enabled: boolean) => {
      setWatchEnabledState(enabled);
      saveWatchEnabled(enabled);
      armWatcher(session, enabled);
    },
    [armWatcher, session],
  );

  // Opening the popup means the user has seen whatever the badge was about.
  useEffect(() => {
    const api = (globalThis as { chrome?: typeof chrome }).chrome;
    void api?.runtime?.sendMessage({ type: "watch:seen" })?.catch(() => undefined);
  }, []);

  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  // Boot is handled by the restore effect below, once openWallet exists — the
  // stored session carries only the secret, so restoring it still has to
  // reconnect and rescan.

  /** When the chain was last verified, so the 60 s poll does not redo it. */
  const lastSpvAtRef = useRef(0);

  /**
   * SPV: verify the header chain from the pinned checkpoint, then prove that each
   * confirmed transaction we are displaying really sits in one of those blocks.
   *
   * Runs in the background and never blocks spending. A failed proof is recorded
   * rather than thrown: the wallet stays usable, but the row stops claiming to be
   * verified, which is the honest outcome if a server is lying.
   */
  const verifySpv = useCallback(
    async (next: Session, entries: HistoryEntry[]) => {
      // The backstop poll reloads history every minute; re-proving the same
      // headers that often is wasted work. Five minutes still covers new
      // confirmations without hammering the server.
      if (Date.now() - lastSpvAtRef.current < 5 * 60_000) return;

      let chain: ChainResult;
      try {
        chain = await syncChain(next.client);
      } catch (e) {
        setSpv({
          ok: false,
          tip: 0,
          tipHash: "",
          checked: 0,
          reason: (e as Error).message || "header verification failed",
          merkleRoots: new Map(),
        });
        return;
      }
      setSpv(chain);
      if (!chain.ok) return;
      lastSpvAtRef.current = Date.now();

      // Each proof costs a round trip, so bound the work: the newest few
      // confirmed rows are what a user actually looks at.
      const confirmed = entries.filter((entry) => entry.height > 0).slice(0, 8);
      if (confirmed.length === 0) return;

      const proofs = await Promise.all(
        confirmed.map(async (entry) => {
          try {
            const proof = await verifyTransaction(
              next.client,
              entry.txid,
              entry.height,
              chain.merkleRoots,
            );
            return [entry.txid, proof] as const;
          } catch {
            return [
              entry.txid,
              { verified: false, reason: "proof request failed", height: entry.height },
            ] as const;
          }
        }),
      );
      const byTxid = new Map(proofs);
      setHistory((current) =>
        (current ?? []).map((entry) => {
          const proof = byTxid.get(entry.txid);
          return proof
            ? { ...entry, verified: proof.verified, verifyNote: proof.reason || undefined }
            : entry;
        }),
      );
    },
    [lastSpvAtRef],
  );

  /**
   * Load confirmation-annotated history in the background, then verify it.
   *
   * Deliberately non-blocking: the wallet is usable before this resolves, and a
   * server that refuses to serve history must not stop the user spending.
   */
  const hydrateHistory = useCallback(async (next: Session) => {
    setHistory(null);
    setTipDrift(null);
    try {
      const result = await loadHistory(next.client, next.scan.addresses, {
        limit: 25,
      });
      setHistory(result.entries);
      setHistoryTotal(result.totalKnown);

      // MEDIUM-2: confirm the primary server's tip against an independent
      // operator. Best effort — a wallet must stay usable if it fails.
      const other = await crossCheckTip(next.secrets.network, next.endpoint);
      if (other) {
        setTipDrift(Math.abs(result.tipHeight - other.height));
      }

      // SPV, with the entries just loaded (passing them in avoids racing state).
      await verifySpv(next, result.entries);
    } catch {
      setHistory([]);
      setHistoryTotal(0);
    }
  }, [verifySpv]);

  /** One scan at a time; push notifications arrive in bursts. */
  const scanningRef = useRef(false);
  /** Active push subscriptions for this unlocked session. */
  const watchRef = useRef<WatchHandle | null>(null);
  /** Indirection so the watcher can trigger the newest runScan without a cycle. */
  const onPushRef = useRef<() => void>(() => {});

  /**
   * Replace the push subscriptions for the current address set.
   *
   * Push is an optimisation, not the only way balances update: if the server
   * refuses a subscription (some cap them) the backstop poll still runs.
   */
  const establishWatch = useCallback(async (next: Session) => {
    try {
      await watchRef.current?.dispose();
    } catch {
      /* ignore */
    }
    watchRef.current = null;
    try {
      watchRef.current = await watchWalletAddresses(
        next.client,
        next.scan.addresses,
        () => onPushRef.current(),
      );
    } catch {
      /* ignore — the poll covers it */
    }
  }, []);

  /** Connect, scan, and hold the wallet in memory. */
  const openWallet = useCallback(async (secrets: WalletSecrets) => {
    setBusy("Connecting to a Radiant server…");
    try {
      const { client, endpoint } = await connect(
        secrets.network,
        secrets.server || getPreferredServer() || undefined,
        (url) => setBusy(`Connecting to ${url.replace("wss://", "")}…`),
      );

      const wallet = HDWallet.fromMnemonic(secrets.mnemonic, {
        network: secrets.network,
      });

      setBusy("Scanning the blockchain…");
      const scan = await scanWallet(client, wallet, {
        onProgress: setBusy,
      });

      const next: Session = { secrets, wallet, client, endpoint, scan };
      setSession(next);
      setScreen("home");
      // Remember the unlock so reopening the popup is not a passphrase prompt.
      // A timeout of 0 stores nothing, which is the "lock immediately" setting.
      // Only reached after a successful connect+scan, so a failed load never
      // leaves a usable session behind.
      await saveSession(secrets, loadUnlockTimeoutMs());
      void hydrateHistory(next);
      void hydratePrice();
      // Subscribe to pushes so the balance keeps itself current.
      void establishWatch(next);
      // And let the background keep watching once the popup closes. Only the
      // endpoint and scripthashes go across, never the secret.
      armWatcher(next, loadWatchEnabled());
    } finally {
      setBusy("");
    }
  }, [hydrateHistory, hydratePrice, establishWatch, armWatcher]);

  /**
   * Restore an unlocked session left behind by a previous popup.
   *
   * `chrome.storage.session` survives the popup being closed but not the browser
   * closing, and it holds only the secret — the Electrum socket died with the
   * previous popup, so this reconnects and rescans. If that fails (offline, server
   * down) the stored secret is dropped and the user lands on Unlock rather than on
   * a broken Home screen.
   */
  useEffect(() => {
    void (async () => {
      setHasExisting(hasVault());
      try {
        const restored = await loadSession();
        if (restored) await openWallet(restored);
      } catch {
        await clearSession();
      } finally {
        setBooted(true);
      }
    })();
  }, [openWallet]);

  /**
   * Re-scan balances against the live connection.
   *
   * `silent` runs it in the background: no "Refreshing…" overlay, no busy text.
   * That path is used by server push notifications and the backstop poll, so an
   * incoming payment never interrupts whatever the user is doing.
   */
  const runScan = useCallback(
    async (silent: boolean) => {
      const current = sessionRef.current;
      // One scan at a time: pushes can arrive in bursts, and overlapping scans
      // would fight over the session.
      if (!current || scanningRef.current) return;
      scanningRef.current = true;
      if (!silent) setBusy("Refreshing…");
      try {
        const scan = await scanWallet(current.client, current.wallet, {
          onProgress: silent ? undefined : setBusy,
        });
        const next = { ...current, scan };
        setSession(next);
        void hydrateHistory(next);
        void hydratePrice();
        // The set of addresses with activity can grow, so re-subscribe.
        void establishWatch(next);
      } finally {
        scanningRef.current = false;
        if (!silent) setBusy("");
      }
    },
    [hydrateHistory, hydratePrice, establishWatch],
  );

  /** User-initiated refresh (Home screen button, after a send). */
  const refresh = useCallback(() => runScan(false), [runScan]);

  // A push notification means "something changed": scan quietly, no overlay.
  useEffect(() => {
    onPushRef.current = () => void runScan(true);
  }, [runScan]);

  // Backstop poll. Pushes normally arrive within a second, but a server that
  // does not push — or a socket that died silently — would otherwise leave the
  // balance stale until the user tapped Refresh. Deliberately gentle (60s) and
  // only while the app is actually on screen.
  const hasSession = session !== null;
  useEffect(() => {
    if (!hasSession) return;
    const POLL_MS = 60_000;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void runScan(true);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [hasSession, runScan]);

  /** Drop the socket and reconnect, optionally to a newly preferred server. */
  const reconnect = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    setBusy("Reconnecting…");
    try {
      await watchRef.current?.dispose();
    } catch {
      /* ignore */
    }
    watchRef.current = null;
    try {
      current.client.close();
    } catch {
      /* ignore */
    }
    try {
      const { client, endpoint } = await connect(
        current.secrets.network,
        getPreferredServer() || undefined,
        (url) => setBusy(`Connecting to ${url.replace("wss://", "")}…`),
      );
      const scan = await scanWallet(client, current.wallet, {
        onProgress: setBusy,
      });
      const next = { ...current, client, endpoint, scan };
      setSession(next);
      void hydrateHistory(next);
      void hydratePrice();
      void establishWatch(next);
      // The watched endpoint may have changed with the server switch.
      armWatcher(next, loadWatchEnabled());
    } finally {
      setBusy("");
    }
  }, [hydrateHistory, hydratePrice, establishWatch, armWatcher]);

  const lock = useCallback(() => {
    const current = sessionRef.current;
    // Stop push subscriptions before the socket goes away, so nothing tries to
    // unsubscribe over a closed connection.
    void watchRef.current?.dispose();
    watchRef.current = null;
    if (current) {
      try {
        current.client.close();
      } catch {
        /* ignore */
      }
    }
    // Drop the remembered unlock too, or closing and reopening the popup would
    // silently undo the lock the user just asked for.
    void clearSession();
    setSession(null);
    setScreen("home");
    setHasExisting(hasVault());
    setHistory(null);
    setHistoryTotal(0);
  }, []);

  // Tear the socket down when the popup goes away. There is no background
  // auto-lock here: the popup context is destroyed rather than backgrounded, and
  // the remembered unlock is bounded by unlockTimeoutMs in src/lib/session.ts.
  useEffect(() => {
    return () => {
      void watchRef.current?.dispose();
      try {
        sessionRef.current?.client.close();
      } catch {
        /* ignore */
      }
    };
  }, []);

  if (!booted) {
    return <Splash />;
  }

  if (!session) {
    if (busy) return <Splash message={busy} />;
    return hasExisting ? (
      <Unlock
        onUnlock={async (passphrase) => {
          const secrets = await unlockVault(passphrase);
          await openWallet(secrets);
        }}
      />
    ) : (
      <Onboarding
        onReady={async (secrets) => {
          await openWallet(secrets);
          setHasExisting(true);
        }}
      />
    );
  }

  const nav = {
    session,
    go: setScreen,
    refresh,
    lock,
    reconnect,
    busy,
    history,
    historyTotal,
    tipDrift,
    unlockTimeoutMs,
    setUnlockTimeoutMs,
    watchEnabled,
    setWatchEnabled,
    spv: spv
      ? { ok: spv.ok, tip: spv.tip, checked: spv.checked, reason: spv.reason }
      : null,
    price,
    fiatEnabled,
    setFiatEnabled,
  };

  return (
    <>
      {screen === "home" && <Home nav={nav} />}
      {screen === "receive" && <Receive nav={nav} />}
      {screen === "send" && <Send nav={nav} />}
      {screen === "settings" && <Settings nav={nav} />}
      {busy && (
        <div className="sheet-backdrop">
          <div className="sheet center">
            <div className="spin" />
            <div style={{ color: "var(--text-dim)", fontSize: 13 }}>{busy}</div>
          </div>
        </div>
      )}
    </>
  );
}

function Splash({ message }: { message?: string }) {
  return (
    <div className="app">
      <div className="splash">
        <BrandMark />
        <div>
          <div style={{ fontWeight: 700, fontSize: 20 }}>Radiant Wallet</div>
          <div style={{ color: "var(--text-faint)", fontSize: 13 }}>
            Non-custodial · RXD
          </div>
        </div>
        {message ? (
          <div style={{ color: "var(--text-dim)", fontSize: 13, maxWidth: 300 }}>
            {message}
          </div>
        ) : (
          <div className="spin" />
        )}
      </div>
    </div>
  );
}
