/**
 * Block explorer links for a transaction.
 *
 * `radiantexplorer.com` is the explorer that actually answered when this was
 * written: `explorer.radiantblockchain.org` (Photonic's default) times out, and
 * `explorer.radiantcore.org` / `rxd.radiantexplorer.com` do not resolve. The
 * `/tx/<txid>` path was verified to return 200 while `/transaction/` and `/txs/`
 * return 404.
 */
export const EXPLORER_TX_BASE = "https://radiantexplorer.com/tx/";

/** Radiant transaction ids are 64 hex characters. */
export function isTxid(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value.trim());
}

/**
 * Explorer URL for a transaction, or null when the txid is not well formed.
 *
 * Returning null rather than a malformed link matters because the URL is handed
 * to the OS: the native plugin only accepts https on an allowlisted host, and
 * this keeps a bad value from ever reaching it.
 */
export function explorerTxUrl(txid: string): string | null {
  const value = txid.trim().toLowerCase();
  return isTxid(value) ? `${EXPLORER_TX_BASE}${value}` : null;
}

/**
 * Hosts the wallet is willing to open.
 *
 * The Android build enforced this in the native plugin. Here it moves into the JS
 * layer: `chrome.tabs.create` will happily navigate anywhere, so the allowlist is
 * what keeps the wallet from becoming a generic URL launcher if a bad value ever
 * reaches a link.
 */
export const ALLOWED_EXPLORER_HOSTS: readonly string[] = [
  "radiantexplorer.com",
  "www.radiantexplorer.com",
];

/** True only for https URLs on an allowlisted explorer host. */
export function isAllowedExplorerUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    ALLOWED_EXPLORER_HOSTS.includes(parsed.hostname.toLowerCase())
  );
}

