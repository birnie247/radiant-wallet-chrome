import { useState } from "react";
import type { ElectrumClient, NetworkName } from "@radiant-core/sdk";
import { deleteVault, unlockVault } from "../lib/vault";
import {
  addCustomServer,
  allServers,
  canonicalServerUrl,
  hiddenServers,
  parseServerUrl,
  removeServer,
  restoreHiddenServers,
  setPreferredServer,
  type ServerEntry,
} from "../lib/servers";
import { connect } from "../lib/wallet";
import { UNLOCK_TIMEOUT_OPTIONS, describeUnlockTimeout, clearSession } from "../lib/session";
import { clearWatchList } from "../lib/watchList";
import { formatRxd, shortId } from "../lib/money";
import { formatUsdPrice } from "../lib/price";
import type { Nav } from "../types";

export default function Settings({ nav }: { nav: Nav }) {
  const { session } = nav;
  const network = session.secrets.network;

  const [confirmWipe, setConfirmWipe] = useState(false);
  const [revealOpen, setRevealOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [revealed, setRevealed] = useState("");
  const [revealError, setRevealError] = useState("");
  const [switching, setSwitching] = useState("");

  const [servers, setServers] = useState<ServerEntry[]>(() => allServers(network));
  const [hiddenCount, setHiddenCount] = useState(
    () => hiddenServers(network).length,
  );
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<ServerEntry | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [serverNote, setServerNote] = useState("");
  const [serverError, setServerError] = useState("");

  function reloadServers() {
    setServers(allServers(network));
    setHiddenCount(hiddenServers(network).length);
  }

  const activeServer = canonicalServerUrl(session.endpoint);

  function openReveal() {
    setRevealOpen(true);
  }

  function closeReveal() {
    setRevealOpen(false);
    setRevealed("");
    setRevealError("");
    setPassphrase("");
  }

  async function chooseServer(url: string) {
    if (canonicalServerUrl(url) === activeServer) return;
    setSwitching(url);
    setServerError("");
    setServerNote("");
    setPreferredServer(url);
    try {
      await nav.reconnect();
      setServerNote(`Connected to ${displayName(url)}.`);
    } catch (e) {
      // Keep it visible: a failed switch leaves the wallet on the old server.
      setServerError((e as Error).message);
    } finally {
      setSwitching("");
    }
  }

  /** A server was added in the sheet: activate it only if its test passed. */
  async function handleAdded(entry: ServerEntry) {
    setAddOpen(false);
    reloadServers();
    setServerError("");
    if (!entry.verified) {
      setServerNote(`${displayName(entry.url)} added. Tap Use to connect to it.`);
      return;
    }
    setPreferredServer(entry.url);
    setSwitching(entry.url);
    setServerNote(`${displayName(entry.url)} added and now in use.`);
    try {
      await nav.reconnect();
    } catch (e) {
      setServerError((e as Error).message);
    } finally {
      setSwitching("");
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    const target = removing;
    setRemoveError("");
    setRemoveBusy(true);
    try {
      const wasActive = canonicalServerUrl(target.url) === activeServer;
      // Throws (leaving the list untouched) if this is the last server.
      removeServer(network, target.url);
      reloadServers();
      setRemoving(null);
      setServerError("");
      setServerNote(
        wasActive
          ? `${displayName(target.url)} removed - reconnecting to another server…`
          : `${displayName(target.url)} removed.`,
      );
      if (wasActive) {
        setSwitching(target.url);
        try {
          await nav.reconnect();
        } finally {
          setSwitching("");
        }
      }
    } catch (e) {
      setRemoveError((e as Error).message);
    } finally {
      setRemoveBusy(false);
    }
  }

  function restoreDefaults() {
    restoreHiddenServers(network);
    reloadServers();
    setServerError("");
    setServerNote("Built-in servers restored.");
  }

  async function reveal() {
    setRevealError("");
    try {
      const secrets = await unlockVault(passphrase);
      setRevealed(secrets.mnemonic);
      setPassphrase("");
    } catch (e) {
      setRevealError((e as Error).message);
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <button className="icon-btn" onClick={() => nav.go("home")}>
          ←
        </button>
        <h1>Settings</h1>
      </div>

      <div className="content">
        <div className="section-title">Wallet</div>
        <div className="card tight">
          <div className="row" style={{ paddingTop: 0 }}>
            <div className="grow">
              <div className="title">Network</div>
              <div className="sub">
                {network === "mainnet" ? "Radiant mainnet" : "Radiant testnet"}
              </div>
            </div>
            <span className="pill live">
              <span className="dot" /> {network}
            </span>
          </div>
          <div className="row">
            <div className="grow">
              <div className="title">Balance</div>
              <div className="sub">
                {session.scan.utxos.length} UTXO
                {session.scan.utxos.length === 1 ? "" : "s"}
              </div>
            </div>
            <div className="value">{formatRxd(session.scan.total, 8)} RXD</div>
          </div>
          <div className="row">
            <div className="grow">
              <div className="title">Next address</div>
              <div className="sub">
                {shortId(session.scan.nextReceive.address, 12, 10)}
              </div>
            </div>
            <div className="sub">{session.scan.nextReceive.path}</div>
          </div>
          <div className="row">
            <div className="grow">
              <div className="title">Connected to</div>
              <div className="sub">{session.endpoint.replace("wss://", "")}</div>
            </div>
          </div>
        </div>

        <div className="section-title">ElectrumX server</div>
        <div className="card tight">
          {servers.map((server) => {
            const active = canonicalServerUrl(server.url) === activeServer;
            const busyRow = !!switching || !!nav.busy;
            return (
              <div className="row" key={server.url}>
                <div className="grow">
                  <div className="title">{displayName(server.url)}</div>
                  <div className="sub">
                    {server.custom ? "added by you" : "built in"} ·{" "}
                    {server.verified ? "verified" : "unverified"}
                    {switching === server.url ? " · connecting…" : ""}
                  </div>
                </div>
                <div
                  style={{ display: "flex", gap: 8, flex: "0 0 auto" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className={`btn small ${active ? "primary" : ""}`}
                    disabled={active || busyRow}
                    onClick={() => void chooseServer(server.url)}
                  >
                    {active ? "In use" : "Use"}
                  </button>
                  <button
                    className="btn small ghost"
                    disabled={busyRow}
                    onClick={() => {
                      setRemoveError("");
                      setRemoving(server);
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="btn-row">
          <button className="btn" onClick={() => setAddOpen(true)}>
            Add a server
          </button>
          {hiddenCount > 0 && (
            <button className="btn ghost" onClick={restoreDefaults}>
              Restore {hiddenCount} removed
            </button>
          )}
        </div>

        {serverError && <div className="error">{serverError}</div>}
        {serverNote && <div className="success-box">{serverNote}</div>}

        <div className="hint">
          If your balance ever looks wrong, switch servers and refresh. Servers
          only index public chain data and never see your keys. A server you add is
          kept in this browser only, and one that failed its test is never used
          automatically — a typo cannot quietly take over the connection.
        </div>

        <div className="section-title">Security</div>
        <div className="stack">
          <button className="btn" onClick={nav.lock}>
            Lock wallet now
          </button>

          <div className="stack" style={{ gap: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Stay unlocked</div>
            <div className="btn-row" style={{ flexWrap: "wrap", gap: 8 }}>
              {UNLOCK_TIMEOUT_OPTIONS.map((option) => (
                <button
                  key={option.ms}
                  className={`btn small ${
                    nav.unlockTimeoutMs === option.ms ? "primary" : ""
                  }`}
                  style={{ flex: "1 1 30%" }}
                  onClick={() => nav.setUnlockTimeoutMs(option.ms)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="hint">
              {nav.unlockTimeoutMs === 0
                ? "Nothing is remembered: every time this popup opens you are asked for your passphrase."
                : `Reopening the popup within ${describeUnlockTimeout(
                    nav.unlockTimeoutMs,
                  )} skips the passphrase. The unlock is held in memory only — never written to disk, cleared when the browser closes — and sending still asks for your passphrase every time.`}
            </div>
          </div>

          <button className="btn" onClick={openReveal}>
            Show recovery phrase
          </button>

          <button
            className="btn"
            onClick={() => nav.setWatchEnabled(!nav.watchEnabled)}
          >
            {nav.watchEnabled
              ? "Stop background updates"
              : "Watch for payments in the background"}
          </button>
          <div className="hint">
            {nav.watchEnabled
              ? "The extension keeps a connection to your server while the popup is closed, and lights the toolbar badge when your addresses change. Only your public addresses are watched — never a key."
              : "While off, balances update only while the popup is open. Nothing stays connected in the background."}
          </div>

          <div className="hint">
            Screenshots cannot be blocked from a browser extension, so the recovery
            phrase sheet asks for your passphrase every time and clears itself when
            closed. Avoid revealing it while screen sharing or recording.
          </div>
        </div>

        <div className="section-title">Display</div>
        <div className="stack">
          <button
            className="btn"
            onClick={() => nav.setFiatEnabled(!nav.fiatEnabled)}
          >
            {nav.fiatEnabled ? "Hide USD value" : "Show USD value"}
          </button>
          <div className="hint">
            {nav.fiatEnabled
              ? `Price from ${nav.price?.source ?? "a public price API"}${
                  nav.price ? `: ${formatUsdPrice(nav.price.usd)} per RXD` : " — unavailable right now"
                }${nav.price?.stale ? " (cached)" : ""}. Requests go to the price provider, which sees your IP address.`
              : "Fiat values are hidden and no price requests are made."}
          </div>
        </div>

        <div className="section-title">Danger zone</div>
        {confirmWipe ? (
          <div className="danger-zone stack">
            <div style={{ fontSize: 13 }}>
              This deletes the encrypted wallet from this device. Without your
              written recovery phrase the funds are gone forever.
            </div>
            <div className="btn-row">
              <button
                className="btn ghost"
                onClick={() => setConfirmWipe(false)}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  // Drop any remembered unlock first, so a deleted vault cannot be
                  // reopened from a session still sitting in memory.
                  void clearSession();
                  // And stop the background watcher: watching a wallet that no
                  // longer exists here would keep a socket to the user's server
                  // advertising addresses they just tried to walk away from.
                  clearWatchList();
                  const api = (globalThis as { chrome?: typeof chrome }).chrome;
                  void api?.runtime?.sendMessage({ type: "watch:stop" })?.catch(() => undefined);
                  deleteVault();
                  window.location.reload();
                }}
              >
                Delete forever
              </button>
            </div>
          </div>
        ) : (
          <button className="btn danger" onClick={() => setConfirmWipe(true)}>
            Delete wallet from this device
          </button>
        )}

        <div className="section-title">About</div>
        <div className="card tight">
          <div className="row" style={{ paddingTop: 0 }}>
            <div className="grow">
              <div className="title">Radiant Wallet</div>
              <div className="sub">v{__APP_VERSION__} · non-custodial</div>
            </div>
          </div>
          <div className="row">
            <div className="grow">
              <div className="title">Derivation</div>
              <div className="sub">BIP44 m/44'/512'/account'/change/index</div>
            </div>
          </div>
          <div className="row">
            <div className="grow">
              <div className="title">Address type</div>
              <div className="sub">P2PKH base58 (Radiant has no SegWit)</div>
            </div>
          </div>
        </div>
      </div>

      {revealOpen && (
        <RevealSheet
          revealed={revealed}
          passphrase={passphrase}
          setPassphrase={setPassphrase}
          error={revealError}
          onReveal={reveal}
          onClose={() => void closeReveal()}
        />
      )}

      {addOpen && (
        <AddServerSheet
          network={network}
          onClose={() => setAddOpen(false)}
          onAdded={(entry) => void handleAdded(entry)}
        />
      )}

      {removing && (
        <RemoveServerSheet
          entry={removing}
          busy={removeBusy}
          error={removeError}
          onCancel={() => {
            if (removeBusy) return;
            setRemoving(null);
            setRemoveError("");
          }}
          onConfirm={() => void confirmRemove()}
        />
      )}
    </div>
  );
}

function RevealSheet({
  revealed,
  passphrase,
  setPassphrase,
  error,
  onReveal,
  onClose,
}: {
  revealed: string;
  passphrase: string;
  setPassphrase: (v: string) => void;
  error: string;
  onReveal: () => void;
  onClose: () => void;
}) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 17 }}>
          {revealed ? "Your recovery phrase" : "Confirm passphrase"}
        </div>

        {revealed ? (
          <>
            <div className="card tight" style={{ background: "var(--bg)" }}>
              <div className="seed-grid">
                {revealed.split(" ").map((w, i) => (
                  <div className="seed-word" key={`${w}-${i}`}>
                    <i>{i + 1}</i>
                    {w}
                  </div>
                ))}
              </div>
            </div>
            <div className="notice">
              Anyone with these words can spend your RXD. Never photograph them
              or type them into a website.
            </div>
            <div className="hint">
              This sheet is a browser page: nothing stops a screenshot or a screen
              recorder. Close it as soon as you have written the words down.
            </div>
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            <div className="field">
              <label>Passphrase</label>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>
            {error && <div className="error">{error}</div>}
            <div className="btn-row">
              <button className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={onReveal}
                disabled={passphrase.length === 0}
              >
                Reveal
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** `wss://host:port` -> `host:port`, for display only. */
function displayName(url: string): string {
  return url.replace(/^wss:\/\//, "");
}

/** `["ElectrumX 1.3.0", "1.4"]` -> `ElectrumX 1.3.0`. */
function describeVersion(raw: unknown): string {
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return typeof raw === "string" ? raw : "";
}

/**
 * Add a user-supplied ElectrumX endpoint.
 *
 * Test is not decoration: the store records `verified` from a real
 * `server.version` handshake, and only a verified server is activated
 * automatically. An untested server is still added, but left inactive, so a typo
 * cannot silently take over the wallet connection.
 */
function AddServerSheet({
  network,
  onClose,
  onAdded,
}: {
  network: NetworkName;
  onClose: () => void;
  onAdded: (entry: ServerEntry) => void;
}) {
  const [input, setInput] = useState("");
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; detail: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const busy = testing || saving;

  async function testConnection() {
    const parsed = parseServerUrl(input);
    if ("error" in parsed) {
      setTest(null);
      setError(parsed.error);
      return;
    }
    setError("");
    setTest(null);
    setTesting(true);
    const startedAt = Date.now();
    let client: ElectrumClient | undefined;
    try {
      const connection = await connect(network, parsed.url, undefined, {
        // Exactly one candidate: this tests THAT server, not the pool.
        candidates: [parsed.url],
        budgetMs: 12_000,
        connectTimeoutMs: 8_000,
        handshakeTimeoutMs: 4_000,
      });
      client = connection.client;
      // The banner comes from the handshake connect() already performed; asking
      // again would be rejected by ElectrumX as a duplicate server.version.
      const banner = describeVersion(connection.serverVersion);
      setTest({
        ok: true,
        detail: `${banner || "Handshake completed"} in ${Date.now() - startedAt} ms`,
      });
    } catch (e) {
      setTest({ ok: false, detail: (e as Error).message });
    } finally {
      try {
        client?.close();
      } catch {
        /* ignore */
      }
      setTesting(false);
    }
  }
  function save() {
    const parsed = parseServerUrl(input);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError("");
    setSaving(true);
    try {
      onAdded(
        addCustomServer(network, parsed.url, { verified: test?.ok === true }),
      );
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={busy ? undefined : onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 17 }}>Add ElectrumX server</div>

        <div className="field">
          <label>Server address</label>
          <input
            className="mono"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setTest(null);
              setError("");
            }}
            placeholder="wss://electrumx.example.org:50022"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
          />
          <div className="hint">
            wss:// only, on the hostname - a certificate cannot prove a bare IP.
            Typing just electrumx.example.org:50022 is treated as wss://.
          </div>
        </div>

        {test?.ok && <div className="success-box">{test.detail}</div>}
        {test && !test.ok && <div className="error">{test.detail}</div>}
        {error && <div className="error">{error}</div>}

        <button
          className="btn"
          disabled={busy || input.trim().length === 0}
          onClick={() => void testConnection()}
        >
          {testing ? "Testing…" : "Test connection"}
        </button>

        <div className="btn-row">
          <button className="btn ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || input.trim().length === 0}
            onClick={save}
          >
            {saving ? "Adding…" : test?.ok ? "Add and use" : "Add"}
          </button>
        </div>

        <div className="hint">
          {test?.ok
            ? "The handshake passed, so this server is used straight away."
            : "Without a test the server is added but not activated - tap Use on its row to switch to it."}
        </div>
      </div>
    </div>
  );
}

function RemoveServerSheet({
  entry,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  entry: ServerEntry;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="sheet-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 17 }}>Remove server?</div>
        <div className="address-box" style={{ padding: 10 }}>
          {displayName(entry.url)}
        </div>
        <div style={{ fontSize: 13, color: "var(--text-body)" }}>
          {entry.custom
            ? "This one was added by you, so it is deleted from the list."
            : "This is a built-in server, so it is only hidden - Settings keeps a Restore button for it."}
        </div>
        {error && <div className="error">{error}</div>}
        <div className="btn-row">
          <button className="btn ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" disabled={busy} onClick={onConfirm}>
            {busy ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}