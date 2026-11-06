import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { Nav } from "../types";

export default function Receive({ nav }: { nav: Nav }) {
  const address = nav.session.scan.nextReceive.address;
  const path = nav.session.scan.nextReceive.path;
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(address, {
      margin: 1,
      width: 640,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((url) => {
        if (alive) setQr(url);
      })
      .catch(() => {
        /* QR is a nicety; the address text is always shown */
      });
    return () => {
      alive = false;
    };
  }, [address]);

  async function copy() {
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    };
    try {
      await navigator.clipboard.writeText(address);
      done();
      return;
    } catch {
      /* fall through to legacy path */
    }
    try {
      const area = document.createElement("textarea");
      area.value = address;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      done();
    } catch {
      /* clipboard unavailable — the user can still read the address */
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <button className="icon-btn" onClick={() => nav.go("home")}>
          ←
        </button>
        <h1>Receive RXD</h1>
      </div>

      <div className="content">
        <div className="qr-wrap">{qr ? <img src={qr} alt={address} /> : null}</div>

        <div className="address-box">{address}</div>

        <button className="btn primary" onClick={copy}>
          {copied ? "Copied ✓" : "Copy address"}
        </button>

        <div className="card tight">
          <div className="row" style={{ paddingTop: 0, paddingBottom: 0 }}>
            <div className="grow">
              <div className="title">Derivation path</div>
              <div className="sub">{path}</div>
            </div>
          </div>
        </div>

        <div className="hint">
          Send only <strong>Radiant (RXD)</strong> to this address. It is a
          legacy base58 P2PKH address — Radiant has no SegWit and no bech32
          addresses, so nothing starting with <code>bc1</code>.
        </div>

        <div className="notice">
          This is a fresh address that has never received funds. Reusing
          addresses weakens your privacy on a public ledger — come back here for
          a new one after each payment arrives.
        </div>
      </div>
    </div>
  );
}
