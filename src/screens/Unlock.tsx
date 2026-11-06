import { useState } from "react";
import { deleteVault } from "../lib/vault";
import BrandMark from "../components/BrandMark";

/**
 * Passphrase unlock.
 *
 * The Android build offered a biometric here. A browser extension has no
 * equivalent: there is no Keystore-backed key bound to a hardware biometric, and
 * the WebAuthn/passkey path proves possession of a credential but cannot decrypt
 * a locally stored key without an authenticator that supports the hmac-secret
 * extension — not something to pretend works on an arbitrary machine. The
 * encrypted vault and its passphrase are therefore the only door, which is why
 * the passphrase minimum is 12 characters and the KDF cost is high.
 */
export default function Unlock({
  onUnlock,
}: {
  onUnlock: (passphrase: string) => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);

  async function submit() {
    setError("");
    setWorking(true);
    try {
      await onUnlock(passphrase);
    } catch (e) {
      setError((e as Error).message);
      setPassphrase("");
      setWorking(false);
    }
  }

  return (
    <div className="app">
      <div
        className="splash"
        style={{ justifyContent: "flex-start", paddingTop: 48 }}
      >
        <BrandMark />
        <div>
          <div style={{ fontWeight: 700, fontSize: 20 }}>Welcome back</div>
          <div style={{ color: "var(--text-faint)", fontSize: 13 }}>
            Enter your passphrase to unlock
          </div>
        </div>
      </div>

      <div className="content" style={{ justifyContent: "flex-end", gap: 14 }}>
        <div className="field">
          <label>Passphrase</label>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Your wallet passphrase"
            autoCapitalize="none"
            autoCorrect="off"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && passphrase.length > 0) void submit();
            }}
          />
        </div>
        {error && <div className="error">{error}</div>}
        <button
          className="btn primary"
          disabled={working || passphrase.length === 0}
          onClick={submit}
        >
          {working ? "Unlocking…" : "Unlock"}
        </button>

        <hr className="hr" />

        {confirmWipe ? (
          <div className="danger-zone stack">
            <div style={{ fontSize: 13 }}>
              This permanently deletes the wallet from this browser. You can only
              get your funds back with your written recovery phrase.
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
                  deleteVault();
                  window.location.reload();
                }}
              >
                Delete wallet
              </button>
            </div>
          </div>
        ) : (
          <button
            className="btn ghost small"
            onClick={() => setConfirmWipe(true)}
          >
            Forgot passphrase?
          </button>
        )}
      </div>
    </div>
  );
}
