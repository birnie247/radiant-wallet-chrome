/**
 * MV3 service worker.
 *
 * It deliberately does very little. The popup is the only context with UI, and it
 * holds the Electrum connection while it is open — there is no dApp provider, no
 * content script and no `web_accessible_resources`, so nothing outside the
 * extension can reach the wallet at all. That leaves this worker one job: seed
 * defaults on first install.
 *
 * It has no imports, on purpose. Anything imported would become a shared chunk the
 * worker has to fetch before it can run, and a service worker that fails to load
 * deregisters the whole extension.
 */

/** Keys must match src/lib/price.ts and src/lib/session.ts. */
const DEFAULTS: Record<string, string> = {
  "rxd.fiat.enabled": "1",
  "rxd.session.timeoutMs": String(5 * 60_000),
};

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    if (details.reason !== "install") return;
    // Only fill gaps: an update must never overwrite the user's settings.
    const existing = await chrome.storage.local.get(null);
    const missing: Record<string, string> = {};
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (!(key in existing)) missing[key] = value;
    }
    if (Object.keys(missing).length > 0) {
      await chrome.storage.local.set(missing);
    }
  })();
});
