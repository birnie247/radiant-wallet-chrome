/**
 * Open a link in a new browser tab.
 *
 * The Android build needed a native plugin for this: its WebView hardening had
 * disabled scripted popups, so `window.open()` silently did nothing. An extension
 * has no WebView to escape — `chrome.tabs.create` is the right API, and creating a
 * tab needs no permission because the extension is opening a URL the user asked
 * for, not reading tabs.
 *
 * The host allowlist is still enforced here. `explorer.ts` already rejects a
 * malformed txid, but a wallet should never act as a general-purpose URL launcher,
 * so the second check stays.
 */
import { isAllowedExplorerUrl } from "./explorer";

export async function openExternalUrl(url: string): Promise<void> {
  if (!isAllowedExplorerUrl(url)) {
    throw new Error("Refusing to open a link that is not an allowlisted explorer");
  }

  const api = (globalThis as { chrome?: typeof chrome }).chrome;
  if (api?.tabs?.create) {
    await api.tabs.create({ url });
    return;
  }

  // Dev server / tests: no chrome API available.
  window.open(url, "_blank", "noopener,noreferrer");
}
