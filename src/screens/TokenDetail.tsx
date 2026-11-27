import { useState } from "react";
import { formatRxd, shortId } from "../lib/money";
import { copyText } from "../lib/clipboard";
import TokenIcon from "../components/TokenIcon";
import type { Nav } from "../types";
import type { TokenBalance } from "../lib/glyphs";

/** Glyph protocol ids seen in the wild (payload `p` array). */
const PROTOCOL_LABELS: Record<number, string> = {
  1: "Fungible",
  2: "Unique",
  4: "WAVE name",
  5: "Mutable",
  6: "Credential",
  7: "Creator",
  8: "Tradeable",
};

export default function TokenDetail({
  nav,
  token,
}: {
  nav: Nav;
  token: TokenBalance;
}) {
  const [copied, setCopied] = useState(false);
  const meta = token.metadata;
  const name = meta?.name ?? meta?.ticker ?? "<Unnamed glyph>";

  async function copyRef() {
    if (!(await copyText(token.refDisplay))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  const attrs = meta?.attrs
    ? Object.entries(meta.attrs).filter(
        ([, v]) => typeof v === "string" || typeof v === "number",
      )
    : [];

  return (
    <div className="app">
      <div className="topbar">
        <button className="icon-btn" onClick={() => nav.go("tokens")}>
          ←
        </button>
        <h1>Token</h1>
      </div>

      <div className="content">
        <div className="card token-head">
          <TokenIcon token={token} size={72} />
          <div className="token-head-body">
            <div className="token-name">{name}</div>
            <div className="token-tags">
              <span className="pill">
                {token.kind === "nft" ? "NFT" : "FT"}
              </span>
              {(meta?.protocols ?? [])
                .filter((id) => id !== (token.kind === "nft" ? 2 : 1))
                .map((id) => (
                  <span key={id} className="pill">
                    {PROTOCOL_LABELS[id] ?? `p:${id}`}
                  </span>
                ))}
            </div>
            {token.kind === "ft" && (
              <div className="token-amount">
                <span className="balance-label">Amount</span>
                <div>{formatRxd(token.amount, 8)}</div>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="row" style={{ paddingTop: 0 }}>
            <div className="grow">
              <div className="title">Artifact id (ref)</div>
              <div className="sub">{shortId(token.refDisplay, 24, 12)}</div>
            </div>
            <button className="btn small" onClick={() => void copyRef()}>
              {copied ? "copied ✓" : "copy"}
            </button>
          </div>
          <div className="row">
            <div className="grow">
              <div className="title">Locked RXD</div>
              <div className="sub">
                {token.utxos.length} output{token.utxos.length === 1 ? "" : "s"}
              </div>
            </div>
            <div className="value">{formatRxd(token.lockedPhotons, 8)} RXD</div>
          </div>
          {attrs.length > 0 && (
            <div className="row">
              <div className="grow">
                <div className="title">Properties</div>
                <div className="token-attrs">
                  {attrs.map(([k, v]) => (
                    <span key={k} className="token-attr">
                      <b>{k}</b> {String(v)}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {meta?.description && (
          <div className="card">
            <div className="balance-label">Description</div>
            <div className="token-desc">{meta.description}</div>
          </div>
        )}

        <div className="section-title">Token outputs</div>
        <div className="card tight">
          {token.utxos.map((u) => (
            <div key={`${u.txid}:${u.vout}`} className="row">
              <div className="grow">
                <div className="sub">
                  {shortId(u.txid, 14, 8)}:{u.vout}
                </div>
                <div className="hint">
                  {u.kind === "nft" ? "NFT" : "FT"} ·{" "}
                  {(u.height ?? 0) > 0 ? `${u.height} conf` : "pending"}
                </div>
              </div>
              <div className="value">{formatRxd(u.value, 8)}</div>
            </div>
          ))}
          <div className="hint">
            These outputs are excluded from ordinary spending — spending one as
            a fee input would destroy the token.
          </div>
        </div>

        <button className="btn primary" onClick={() => nav.openTokenSend(token)}>
          Send {token.kind === "nft" ? "token" : formatRxd(token.amount, 0)}
        </button>
      </div>
    </div>
  );
}