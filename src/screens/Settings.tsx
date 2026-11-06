import { useState } from "react";
import { deleteVault, unlockVault } from "../lib/vault";
import { SERVERS, setPreferredServer } from "../lib/servers";
import { UNLOCK_TIMEOUT_OPTIONS, describeUnlockTimeout, clearSession } from "../lib/session";
import { formatRxd, shortId } from "../lib/money";
import { formatUsdPrice } from "../lib/price";
import type { Nav } from "../types";

export default function Settings({ nav }: { nav: Nav }) {
  const { session } = nav;
  const network = session.secrets.network;
  const servers = SERVERS[network];

  const [confirmWipe, setConfirmWipe] = useState(false);
  const [revealOpen, setRevealOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [revealed, setRevealed] = useState("");
  const [revealError, setRevealError] = useState("");
  const [switching, setSwitching] = useState("");

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
    if (url === session.endpoint) return;
    setSwitching(url);
    setPreferredServer(url);
    try {
      await nav.reconnect();
    } finally {
      setSwitching("");
    }
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
            const active = server.url === session.endpoint;
            return (
              <div className="row" key={server.url}>
                <div className="grow">
                  <div className="title">{server.url.replace("wss://", "")}</div>
                  <div className="sub">
                    {server.verified ? "verified" : "unverified"}
                    {switching === server.url ? " · connecting…" : ""}
                  </div>
                </div>
                <button
                  className={`btn small ${active ? "primary" : ""}`}
                  disabled={active || !!switching || !!nav.busy}
                  onClick={() => void chooseServer(server.url)}
                >
                  {active ? "In use" : "Use"}
                </button>
              </div>
            );
          })}
        </div>

        <div className="hint">
          If your balance ever looks wrong, switch servers and refresh. Servers
          only index public chain data and never see your keys.
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
