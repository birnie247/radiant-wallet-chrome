import { useState } from "react";
import { formatRxd, parseRxd, shortId } from "../lib/money";
import { explorerTxUrl } from "../lib/explorer";
import { openExternalUrl } from "../lib/openTab";
import { confirmWithPassphrase } from "../lib/reauth";
import {
  FAST_FEE_RATE,
  MIN_FEE_RATE,
  checkAddress,
} from "../lib/wallet";
import {
  FT_DUST_LIMIT,
  estimateTokenSendFee,
  sendFtAmount,
  sendWholeToken,
} from "../lib/glyphs";
import TokenIcon from "../components/TokenIcon";
import type { Nav } from "../types";
import type { TokenBalance } from "../lib/glyphs";

const FEE_TIERS: { label: string; rate: bigint; note: string }[] = [
  { label: "Standard", rate: MIN_FEE_RATE, note: "~10k photons/byte" },
  { label: "Fast", rate: 25_000n, note: "~25k photons/byte" },
  { label: "Priority", rate: FAST_FEE_RATE, note: "~50k photons/byte" },
];

export default function TokenSend({
  nav,
  token,
}: {
  nav: Nav;
  token: TokenBalance;
}) {
  const { session } = nav;
  const network = session.secrets.network;
  const isNft = token.kind === "nft";
  const name = token.metadata?.name ?? token.metadata?.ticker ?? "<Unnamed glyph>";

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [feeRate, setFeeRate] = useState<bigint>(MIN_FEE_RATE);
  const [review, setReview] = useState(false);
  const [txid, setTxid] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [passphrase, setPassphrase] = useState("");

  const trimmedTo = to.trim();
  const addressCheck = trimmedTo ? checkAddress(trimmedTo) : null;

  function parseAmountSafe(): bigint | null {
    if (isNft) return token.amount;
    try {
      return parseRxd(amount);
    } catch {
      return null;
    }
  }

  /** Flight-check before the review sheet opens. */
  function preflight(): { amount: bigint; error: string } {
    const parsed = parseAmountSafe();
    if (!parsed || parsed <= 0n) {
      return { amount: 0n, error: isNft ? "" : "Enter an amount" };
    }
    if (!isNft && parsed > token.amount) {
      return {
        amount: parsed,
        error: `You hold ${formatRxd(token.amount, 8)} of this token`,
      };
    }
    if (!isNft && parsed < FT_DUST_LIMIT) {
      return {
        amount: parsed,
        error: `A Glyph FT output's value IS the amount — the minimum single send is ${FT_DUST_LIMIT.toString()} base units`,
      };
    }
    return { amount: parsed, error: "" };
  }

  async function performSend(secret: string) {
    const { amount: parsed, error: preflightError } = preflight();
    if (preflightError) {
      setError(preflightError);
      setReview(false);
      return;
    }
    setError("");
    setWorking(true);
    try {
      // Send-time re-authentication, identical to an RXD payment: an unlocked
      // session must not be sufficient to move tokens on its own. The extension
      // offers the passphrase only — no browser biometric actually unwraps a
      // locally held key (see reauth.ts).
      await confirmWithPassphrase(secret, session.secrets);
    } catch (e) {
      setError((e as Error).message || "Could not confirm this send");
      setWorking(false);
      return;
    }
    try {
      // Both helpers broadcast internally, so there is no second broadcast
      // step — and no window where a signed toxic transaction sits in memory.
      const sent =
        isNft || parsed === token.amount
          ? await sendWholeToken({
              client: session.client,
              scan: session.scan,
              token,
              to: trimmedTo,
              feeRate,
              network,
            })
          : await sendFtAmount({
              client: session.client,
              scan: session.scan,
              token,
              to: trimmedTo,
              amount: parsed,
              feeRate,
              network,
            });
      setTxid(sent.txid);
      setReview(false);
      await nav.refresh();
    } catch (e) {
      setError((e as Error).message);
      setReview(false);
    } finally {
      setWorking(false);
    }
  }

  function useMax() {
    if (isNft) return;
    setAmount(formatRxd(token.amount, 8).replace(/,/g, ""));
  }
  if (txid) {
    return (
      <div className="app">
        <div className="topbar">
          <button className="icon-btn" onClick={() => nav.go("tokens")}>
            ×
          </button>
          <h1>Sent</h1>
        </div>
        <div className="content">
          <div className="success-box">Token transaction broadcast.</div>
          <div className="card">
            <div className="balance-label">Transaction ID</div>
            <div className="address-box" style={{ textAlign: "left" }}>
              {txid}
            </div>
          </div>
          {explorerTxUrl(txid) && (
            <button
              className="btn"
              onClick={() => {
                const url = explorerTxUrl(txid);
                if (url) void openExternalUrl(url).catch(() => undefined);
              }}
            >
              View on explorer ↗
            </button>
          )}
          <div className="hint">
            The output carrying {name} is now owned by the recipient. Your
            balance updates on the next refresh.
          </div>
          <button className="btn primary" onClick={() => nav.go("home")}>
            Done
          </button>
        </div>
      </div>
    );
  }

  const pre = preflight();
  const estFee = estimateTokenSendFee(
    session.scan,
    token,
    isNft ? null : pre.amount || null,
    feeRate,
  );

  return (
    <div className="app">
      <div className="topbar">
        <button className="icon-btn" onClick={() => nav.go("tokens")}>
          ←
        </button>
        <h1>Send token</h1>
      </div>

      <div className="content">
        <div className="card tight">
          <div className="row" style={{ paddingTop: 0 }}>
            <TokenIcon token={token} size={36} />
            <div className="grow">
              <div className="title">{name}</div>
              <div className="sub">
                {isNft
                  ? `Whole token · ${formatRxd(token.lockedPhotons, 8)} RXD inside`
                  : `You hold ${formatRxd(token.amount, 8)}`}
              </div>
            </div>
          </div>
        </div>

        {!isNft && (
          <div className="field">
            <label>Amount (base units)</label>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00000000"
              inputMode="decimal"
              autoCorrect="off"
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div className="hint">
                Minimum {FT_DUST_LIMIT.toString()} units per send
              </div>
              <button className="btn small ghost" onClick={useMax}>
                Max
              </button>
            </div>
          </div>
        )}

        <div className="field">
          <label>To</label>
          <input
            className="mono"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="Radiant address (starts with 1)"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          {addressCheck && !addressCheck.ok && (
            <div className="error">{addressCheck.error}</div>
          )}
          {addressCheck?.ok && <div className="hint">Address looks valid ✓</div>}
        </div>

        <div className="field">
          <label>Network fee</label>
          <div className="btn-row">
            {FEE_TIERS.map((tier) => (
              <button
                key={tier.label}
                className={`btn small ${feeRate === tier.rate ? "primary" : ""}`}
                style={{ flex: 1 }}
                onClick={() => setFeeRate(tier.rate)}
                title={tier.note}
              >
                {tier.label}
              </button>
            ))}
          </div>
          <div className="hint">
            Paid from your ordinary RXD balance — the token output is never
            spent as a fee, so the token cannot be burned by sending it.
          </div>
        </div>

        {error && !review && <div className="error">{error}</div>}

        <div className="spacer" />
        <button
          className="btn primary"
          disabled={!addressCheck?.ok || working || (!isNft && !amount)}
          onClick={() => {
            const { error: e } = preflight();
            if (e) {
              setError(e);
              return;
            }
            setError("");
            setReview(true);
          }}
        >
          Review transfer
        </button>
      </div>
      {review && (
        <div className="sheet-backdrop" onClick={() => setReview(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 700, fontSize: 17 }}>
              Confirm token transfer
            </div>

            <div className="card tight" style={{ background: "var(--bg)" }}>
              <div className="row" style={{ paddingTop: 0 }}>
                <TokenIcon token={token} size={32} />
                <div className="grow">
                  <div className="title">{name}</div>
                  <div className="sub">{shortId(token.refDisplay, 14, 8)}</div>
                </div>
                <div className="value">
                  {isNft ? "1 whole token" : formatRxd(pre.amount, 8)}
                </div>
              </div>
              <div className="row">
                <div className="grow">
                  <div className="title">To</div>
                  <div className="sub">{shortId(trimmedTo, 14, 10)}</div>
                </div>
              </div>
              <div className="row">
                <div className="grow">
                  <div className="title">Est. network fee</div>
                  <div className="sub">
                    {estFee === null
                      ? "unavailable — check fee balance"
                      : pre.amount === token.amount
                        ? "whole-balance send"
                        : "partial send"}
                  </div>
                </div>
                <div className="value">
                  {estFee === null ? "—" : `≈ ${formatRxd(estFee, 8)} RXD`}
                </div>
              </div>
            </div>

            {error && <div className="error">{error}</div>}

            <div className="field">
              <label>Confirm passphrase</label>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Re-enter to authorise this transfer"
                autoCapitalize="none"
                autoCorrect="off"
                disabled={working}
              />
              <div className="hint">
                Required even though the wallet is unlocked — this is what stops
                a hijacked session from moving tokens on your behalf.
              </div>
            </div>

            <div className="hint">
              Signed on this device. A broadcast token transfer cannot be
              undone — the recipient becomes the owner immediately.
            </div>

            <div className="btn-row">
              <button
                className="btn ghost"
                onClick={() => setReview(false)}
                disabled={working}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => void performSend(passphrase)}
                disabled={working || passphrase.length === 0}
              >
                {working ? "Sending…" : "Confirm & send"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}