import { formatRxd, shortId } from "../lib/money";
import { explorerTxUrl } from "../lib/explorer";
import { openExternalUrl } from "../lib/openTab";
import type { HistoryEntry } from "../lib/history";

function relativeTime(seconds?: number): string {
  if (!seconds) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 30 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

function confirmationBadge(confirmations: number): {
  label: string;
  className: string;
} {
  if (confirmations <= 0) return { label: "Pending", className: "pill warn" };
  if (confirmations < 3) {
    return { label: `${confirmations} conf`, className: "pill warn" };
  }
  return { label: `${confirmations} confs`, className: "pill live" };
}

function ActivityRow({ entry }: { entry: HistoryEntry }) {
  const badge = confirmationBadge(entry.confirmations);
  const incoming = entry.direction === "received";
  const outgoing = entry.direction === "sent";

  const label = incoming ? "Received" : outgoing ? "Sent" : "Self transfer";
  const glyph = incoming ? "↓" : outgoing ? "↑" : "⇄";
  const sign = incoming ? "+" : outgoing ? "−" : "";
  const amount = entry.net < 0n ? -entry.net : entry.net;

  // Opening the transaction in a block explorer is the whole point of the row
  // being tappable, so it needs the link to be well formed. Null here only
  // happens for a corrupt txid, in which case the row stays inert.
  const exploreUrl = explorerTxUrl(entry.txid);
  const openExplorer = () => {
    if (exploreUrl) void openExternalUrl(exploreUrl).catch(() => undefined);
  };

  const body = (
    <>
      <div
        style={{
          width: 30,
          textAlign: "center",
          fontSize: 16,
          color: incoming
            ? "var(--success)"
            : outgoing
              ? "var(--accent)"
              : "var(--text-dim)",
        }}
        aria-hidden
      >
        {glyph}
      </div>
      <div className="grow">
        <div className="title">{label}</div>
        <div className="sub">
          {shortId(entry.txid, 10, 8)}
          {entry.time ? ` · ${relativeTime(entry.time)}` : ""}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div
          className="value"
          style={{
            color: incoming
              ? "var(--success)"
              : outgoing
                ? "var(--text)"
                : "var(--text-dim)",
          }}
        >
          {sign}
          {formatRxd(amount, 6)}
        </div>
        <div style={{ marginTop: 4 }}>
          <span className={badge.className} style={{ fontSize: 10 }}>
            {entry.confirmations === 0 && <span className="dot" />}
            {badge.label}
          </span>
        </div>
      </div>
    </>
  );

  if (!exploreUrl) {
    return <div className="row">{body}</div>;
  }

  return (
    <button
      type="button"
      className="row row-button"
      onClick={openExplorer}
      aria-label={`View transaction ${entry.txid} in the block explorer`}
    >
      {body}
      <span className="row-chevron" aria-hidden="true">
        ↗
      </span>
    </button>
  );
}

export default function ActivityList({
  entries,
  totalKnown,
}: {
  entries: HistoryEntry[] | null;
  totalKnown: number;
}) {
  if (entries === null) {
    return (
      <div className="card tight center" style={{ padding: 26 }}>
        <div className="spin" />
        <div className="hint" style={{ marginTop: 12 }}>
          Loading transaction history…
        </div>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="card tight">
        <div className="hint">
          No transactions yet. Confirmation counts appear here once this wallet
          has on-chain activity.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card tight">
        {entries.map((entry) => (
          <ActivityRow key={`${entry.txid}`} entry={entry} />
        ))}
      </div>
      {totalKnown > entries.length && (
        <div className="hint">
          Showing the {entries.length} most recent of {totalKnown} transactions.
        </div>
      )}
    </>
  );
}
