import { useState } from "react";
import { HDWallet } from "@radiant-core/sdk";
import { checkPassphrase, saveVault, type WalletSecrets } from "../lib/vault";
import BrandMark from "../components/BrandMark";

type Step = "welcome" | "create" | "restore" | "passphrase";

function normaliseMnemonic(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

export default function Onboarding({
  onReady,
}: {
  onReady: (secrets: WalletSecrets) => Promise<void>;
}) {
  const [step, setStep] = useState<Step>("welcome");
  const [mnemonic, setMnemonic] = useState("");
  const [restoreInput, setRestoreInput] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [repeat, setRepeat] = useState("");
  const [savedSeed, setSavedSeed] = useState(false);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);

  const words = mnemonic ? mnemonic.split(" ") : [];

  function startCreate() {
    setError("");
    setMnemonic(HDWallet.generateMnemonic());
    setSavedSeed(false);
    setStep("create");
  }

  function startRestore() {
    setError("");
    setRestoreInput("");
    setStep("restore");
  }

  function leaveSensitive(next: Step) {
    setStep(next);
  }

  async function acceptRestore() {
    const candidate = normaliseMnemonic(restoreInput);
    const count = candidate ? candidate.split(" ").length : 0;
    if (![12, 15, 18, 21, 24].includes(count)) {
      setError(
        `A recovery phrase has 12, 15, 18, 21 or 24 words (got ${count}).`,
      );
      return;
    }
    try {
      HDWallet.fromMnemonic(candidate, { network: "mainnet" });
    } catch {
      setError(
        "That recovery phrase is not valid — check the words and spelling.",
      );
      return;
    }
    setError("");
    setMnemonic(candidate);
    await leaveSensitive("passphrase");
  }

  async function finish() {
    setError("");
    // Policy lives in the vault module so creation and unlock can never drift.
    const policyError = checkPassphrase(passphrase);
    if (policyError) {
      setError(policyError);
      return;
    }
    if (passphrase !== repeat) {
      setError("The passphrases do not match.");
      return;
    }
    setWorking(true);
    try {
      const secrets: WalletSecrets = {
        mnemonic,
        network: "mainnet",
        server: "",
        label: "Radiant",
        createdAt: Date.now(),
      };
      await saveVault(passphrase, secrets);
      await onReady(secrets);
    } catch (e) {
      setError((e as Error).message);
      setWorking(false);
    }
  }

  if (step === "welcome") {
    return (
      <div className="app">
        <div
          className="splash"
          style={{ justifyContent: "flex-start", paddingTop: 40 }}
        >
          <BrandMark />
          <div>
            <div style={{ fontWeight: 700, fontSize: 22 }}>Radiant Wallet</div>
            <div style={{ color: "var(--text-faint)", fontSize: 13 }}>
              Non-custodial RXD · keys stay on this device
            </div>
          </div>
        </div>
        <div
          className="content"
          style={{ justifyContent: "flex-end", gap: 12 }}
        >
          <div className="notice">
            Your recovery phrase is the only way to restore this wallet. Nobody
            — not the developers, not any server — can recover it for you.
          </div>
          <button className="btn primary" onClick={() => void startCreate()}>
            Create a new wallet
          </button>
          <button className="btn" onClick={() => void startRestore()}>
            Restore from recovery phrase
          </button>
        </div>
      </div>
    );
  }

  if (step === "create") {
    return (
      <div className="app">
        <div className="topbar">
          <button
            className="icon-btn"
            onClick={() => void leaveSensitive("welcome")}
          >
            ←
          </button>
          <h1>Back up your wallet</h1>
        </div>
        <div className="content">
          <div className="notice">
            Write these 12 words down in order and keep them offline. Anyone who
            has them can spend your RXD.
          </div>
          <div className="card">
            <div className="seed-grid">
              {words.map((w, i) => (
                <div className="seed-word" key={`${w}-${i}`}>
                  <i>{i + 1}</i>
                  {w}
                </div>
              ))}
            </div>
          </div>
          <label className="row" style={{ border: "none", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={savedSeed}
              onChange={(e) => setSavedSeed(e.target.checked)}
              style={{ width: 22, height: 22, flex: "0 0 auto" }}
            />
            <div className="grow" style={{ fontSize: 14 }}>
              I have written down my recovery phrase
            </div>
          </label>
          <button
            className="btn primary"
            disabled={!savedSeed}
            onClick={() => void leaveSensitive("passphrase")}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  if (step === "restore") {
    return (
      <div className="app">
        <div className="topbar">
          <button
            className="icon-btn"
            onClick={() => void leaveSensitive("welcome")}
          >
            ←
          </button>
          <h1>Restore wallet</h1>
        </div>
        <div className="content">
          <div className="field">
            <label>Recovery phrase</label>
            <textarea
              className="mono"
              rows={4}
              value={restoreInput}
              onChange={(e) => setRestoreInput(e.target.value)}
              placeholder="word1 word2 word3 …"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <div className="hint">
              12–24 words separated by spaces. Radiant uses the standard BIP39
              word list.
            </div>
          </div>
          {error && <div className="error">{error}</div>}
          <button className="btn primary" onClick={() => void acceptRestore()}>
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="topbar">
        <button
          className="icon-btn"
          onClick={() => setStep("welcome")}
          disabled={working}
        >
          ←
        </button>
        <h1>Protect this wallet</h1>
      </div>
      <div className="content">
        <div className="hint">
          This passphrase encrypts your recovery phrase on this device. It is
          never sent anywhere. If you forget it, you will need your written
          recovery phrase to get back in.
        </div>
        <div className="field">
          <label>Passphrase</label>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="At least 12 characters"
            autoCapitalize="none"
            autoCorrect="off"
          />
        </div>
        <div className="field">
          <label>Confirm passphrase</label>
          <input
            type="password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </div>
        {error && <div className="error">{error}</div>}
        <button className="btn primary" onClick={finish} disabled={working}>
          {working ? "Creating wallet…" : "Create wallet"}
        </button>
      </div>
    </div>
  );
}
