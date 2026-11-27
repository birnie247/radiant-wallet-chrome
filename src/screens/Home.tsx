import { useState } from "react";
import { formatRxd, shortId } from "../lib/money";
import { formatUsdBalance } from "../lib/price";
import { MAX_TIP_DRIFT } from "../lib/wallet";
import { describeProofs } from "../lib/spv";
import { copyText } from "../lib/clipboard";
import ActivityList from "../components/ActivityList";
import BrandMark from "../components/BrandMark";
import type { Nav } from "../types";

export default function Home({ nav }: { nav: Nav }) {
  const { session } = nav;
  const { scan, secrets, endpoint } = session;

  // Which address was just copied, so the row can say so for a moment.
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);

  // Count every used address, not a display-sized slice: the row is a fact
  // about the wallet, and capping it at 6 silently under-reported once the
  // wallet had more derivation indices in play than that.
  const usedAddressCount = scan.addresses.filter((a) => a.used).length;

  // SPV summary. The wording lives in spv.ts so it can be tested: it must not
  // confuse "nothing confirmed yet" with "not checked" or with a failed proof.
  const confirmedCount = (nav.history ?? []).filter((e) => e.height > 0).length;
  const proofsFailed =
    nav.spvProofs !== null && nav.spvProofs.proven < nav.spvProofs.checked;

  // Compose per-address totals from the UTXO set we already hold.
  const perAddress = new Map<string, bigint>();
  for (const u of scan.utxos) {
    perAddress.set(u.ownerAddress, (perAddress.get(u.ownerAddress) ?? 0n) + u.value);
  }

  // Copying needs the whole address, not the ellipsised label, and only claims
  // success when the clipboard write actually succeeded.
  async function copyAddress(address: string) {
    if (!(await copyText(address))) return;
    setCopiedAddress(address);
    window.setTimeout(() => {
      setCopiedAddress((current) => (current === address ? null : current));
    }, 1600);
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <BrandMark />
          <div className="brand-name">
            Lumen RXD
            <small>
              {secrets.network === "mainnet" ? "Mainnet" : "Testnet"} · RXD
            </small>
          </div>
        </div>
        <button
          className="icon-btn"
          aria-label="Settings"
          onClick={() => nav.go("settings")}
        >
          ⚙
        </button>
      </div>

      <div className="content">
        <div className="balance-card">
          <div className="balance-label">Total balance</div>
          <div className="balance-amount">
            {formatRxd(scan.total, 8).split(".")[0]}
            <span className="unit">RXD</span>
          </div>
          {nav.fiatEnabled && nav.price && (
            <div className="balance-fiat">
              ≈ {formatUsdBalance(scan.total, nav.price.usd)}
              {nav.price.stale && (
                <span className="balance-fiat-note">cached</span>
              )}
            </div>
          )}
          <div className="balance-sub">
            {formatRxd(scan.total, 8).includes(".") && (
              <span>{formatRxd(scan.total, 8)}</span>
            )}
            <span>
              <span className="dot" style={{ color: "var(--success)" }} />{" "}
              {formatRxd(scan.confirmed, 6)} confirmed
            </span>
            {scan.unconfirmed !== 0n && (
              <span style={{ color: "var(--accent)" }}>
                {formatRxd(scan.unconfirmed, 6)} pending
              </span>
            )}
            {nav.lockedPhotons > 0n && (
              <span style={{ color: "var(--accent)" }}>
                {formatRxd(nav.lockedPhotons, 4)} RXD in tokens — not spendable
                as fees
              </span>
            )}
          </div>
        </div>

        <div className="actions trio">
          <button className="action" onClick={() => nav.go("send")}>
            <span className="glyph">↑</span>
            Send
          </button>
          <button className="action" onClick={() => nav.go("receive")}>
            <span className="glyph">↓</span>
            Receive
          </button>
          <button className="action" onClick={() => nav.go("tokens")}>
            <span className="glyph">◈</span>
            Tokens
          </button>
        </div>

        {nav.tipDrift !== null && nav.tipDrift > MAX_TIP_DRIFT && (
          <div className="notice">
            <strong>Server disagreement.</strong> This server's chain tip is{" "}
            {nav.tipDrift} blocks away from an independent operator. Confirmation
            counts shown here may be unreliable — switch servers in Settings
            before trusting them.
          </div>
        )}

        {scan.tokenUtxoCount > 0 && (
          <div className="notice">
            {scan.tokenUtxoCount} of your outputs carry a Glyph token. They are
            excluded from spending automatically so the token can never be
            burned as a fee.
          </div>
        )}

        {nav.spv && (
          <div className={proofsFailed ? "error" : "hint"}>
            {nav.spv.ok
              ? `Chain verified to block ${nav.spv.tip} — ${describeProofs(
                  nav.spvProofs,
                  confirmedCount,
                )}.`
              : `Could not verify the chain: ${nav.spv.reason}. Balances are shown as the server reports them, unproven.`}
          </div>
        )}

        <div className="card">
          <div className="row" style={{ paddingTop: 0 }}>
            <div className="grow">
              <div className="title">Network</div>
              <div className="sub">{endpoint.replace("wss://", "")}</div>
            </div>
            <button
              className="btn small"
              onClick={() => void nav.refresh()}
              disabled={!!nav.busy}
            >
              Refresh
            </button>
          </div>
          <div className="row">
            <div className="grow">
              <div className="title">UTXOs</div>
              <div className="sub">
                {scan.utxos.length} spendable output
                {scan.utxos.length === 1 ? "" : "s"}
              </div>
            </div>
            <div className="value">
              {usedAddressCount} address
              {usedAddressCount === 1 ? "" : "es"}
            </div>
          </div>
        </div>

        <div className="section-title">Recent activity</div>
        <ActivityList entries={nav.history} totalKnown={nav.historyTotal} />

        {perAddress.size > 0 && (
          <>
            <div className="section-title">Funds by address</div>
            <div className="card tight">
              {[...perAddress.entries()].map(([address, value]) => {
                const copied = copiedAddress === address;
                return (
                  <button
                    key={address}
                    type="button"
                    className="row row-button"
                    onClick={() => void copyAddress(address)}
                    title={address}
                    aria-label={
                      copied
                        ? `Address ${address} copied`
                        : `Copy address ${address}`
                    }
                  >
                    <div className="grow">
                      <div className="sub">{shortId(address, 12, 10)}</div>
                    </div>
                    <div className="value">{formatRxd(value, 6)}</div>
                    <span
                      className={copied ? "copy-tag copied" : "copy-tag"}
                      aria-hidden="true"
                    >
                      {copied ? "copied ✓" : "copy"}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="hint">Tap an address to copy the full value.</div>
          </>
        )}

        {scan.total === 0n && (
          <div className="notice">
            This wallet is empty. Tap <strong>Receive</strong> to get your first
            address — funds sent to it will show up here after the next refresh.
          </div>
        )}
      </div>
    </div>
  );
}
