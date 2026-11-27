import { formatRxd, shortId } from "../lib/money";
import TokenIcon from "../components/TokenIcon";
import type { Nav } from "../types";

/**
 * Token list. Identity is the ref, and the row shows the ref so two tokens
 * with an identical name stay visually distinguishable.
 */
export default function Tokens({ nav }: { nav: Nav }) {
  const { tokens, tokensScanning, tokensError } = nav.session;

  return (
    <div className="app">
      <div className="topbar">
        <button className="icon-btn" onClick={() => nav.go("home")}>
          ←
        </button>
        <h1>Glyph tokens</h1>
      </div>

      <div className="content">
        {tokensError && (
          <div className="notice">
            The token list could not be refreshed — showing the last known
            balances. Tap Refresh on Home to try again.
          </div>
        )}

        {tokens.length > 0 && (
          <div className="card tight">
            {tokens.map((token) => (
              <button
                key={token.ref}
                type="button"
                className="row row-button token-row"
                onClick={() => nav.openToken(token)}
                title={token.refDisplay}
              >
                <TokenIcon token={token} />
                <div className="grow">
                  <div className="title">
                    {token.metadata?.name ??
                      token.metadata?.ticker ??
                      "<Unnamed glyph>"}
                  </div>
                  <div className="sub">{shortId(token.refDisplay, 18, 6)}</div>
                </div>
                <div className="value">
                  {token.kind === "nft" ? "NFT" : formatRxd(token.amount, 8)}
                </div>
                <span className="row-chevron">›</span>
              </button>
            ))}
          </div>
        )}

        {!tokensScanning && tokens.length === 0 && !tokensError && (
          <div className="notice">
            No Glyph tokens in this wallet. Any tokens minted to, or sent to,
            one of your addresses show up here after a refresh.
          </div>
        )}

        {tokensScanning && tokens.length === 0 && (
          <div className="card center">
            <div className="spin" />
            <div className="hint" style={{ marginTop: 10 }}>
              Scanning token indexes…
            </div>
          </div>
        )}

        <div className="hint">
          Balances are grouped by artifact id (ref), never by name or ticker —
          two different tokens can freely share a name. The RXD riding inside
          token outputs cannot be spent as fees, so it can never be burned.
        </div>
      </div>
    </div>
  );
}