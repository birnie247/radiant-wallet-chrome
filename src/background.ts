/**
 * MV3 service worker.
 *
 * Three jobs, all small:
 *   1. seed defaults on install;
 *   2. own the offscreen document that holds the Electrum subscription, because a
 *      worker cannot keep a socket itself;
 *   3. turn "the chain moved" into a badge on the toolbar icon.
 *
 * It still imports nothing. A service worker that fails to load deregisters the
 * extension, so every dependency is one more way to brick it.
 */

/** Must match src/lib/price.ts, src/lib/session.ts and src/lib/watchList.ts. */
const DEFAULTS: Record<string, string> = {
  "rxd.fiat.enabled": "1",
  "rxd.session.timeoutMs": String(5 * 60_000),
  "rxd.watch.enabled": "1",
};

const WATCH_KEY = "rxd.watch.list";
const ENABLED_KEY = "rxd.watch.enabled";
const OFFSET_KEY = "rxd.watch.lastActivity";
const BADGE_KEY = "rxd.watch.unseen";

async function getLocal(key: string): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(key);
  const value = stored[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Make sure the offscreen document exists.
 *
 * Chrome allows one per extension and throws if one is already there, so presence
 * is checked first rather than caught. The watcher reads the watch list itself, so
 * starting it needs no payload — which is also why the service worker never handles
 * an address list or a key.
 */
async function ensureWatcher(): Promise<boolean> {
  if ((await getLocal(ENABLED_KEY)) === "0") return false;
  if (!(await getLocal(WATCH_KEY))) return false;

  try {
    if (await chrome.offscreen.hasDocument()) return true;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      // Chrome demands a reason, and WORKERS is the one intended for "keep
      // something running" — there is no WebSocket-specific reason. It is cast
      // because @types/chrome 0.0.287 predates the WORKERS enum member (Chrome
      // 116); the runtime value is what matters.
      reasons: ["WORKERS"] as unknown as chrome.offscreen.Reason[],
      justification:
        "Keeps an Electrum subscription open so incoming payments are noticed while the popup is closed.",
    });
    return true;
  } catch (e) {
    // A second concurrent call can race the first; treat "already exists" as fine.
    console.warn("offscreen create failed", e);
    try {
      return await chrome.offscreen.hasDocument();
    } catch {
      return false;
    }
  }
}

async function stopWatcher(): Promise<void> {
  try {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  } catch (e) {
    console.warn("offscreen close failed", e);
  }
}

/** Parse the stored watch list into what the offscreen document needs. */
async function readWatchConfig(): Promise<{
  endpoint: string;
  scripthashes: string[];
} | null> {
  if ((await getLocal(ENABLED_KEY)) === "0") return null;
  const raw = await getLocal(WATCH_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { endpoint?: string; scripthashes?: string[] };
    if (
      typeof parsed.endpoint !== "string" ||
      !parsed.endpoint.startsWith("wss://") ||
      !Array.isArray(parsed.scripthashes) ||
      parsed.scripthashes.length === 0
    ) {
      return null;
    }
    return { endpoint: parsed.endpoint, scripthashes: parsed.scripthashes };
  } catch {
    return null;
  }
}

/**
 * Tell the offscreen document what to watch.
 *
 * The document cannot read storage itself (offscreen documents only get a subset of
 * extension APIs), so configuration is pushed from here.
 */
async function pushConfig(): Promise<void> {
  const config = await readWatchConfig();
  try {
    await chrome.runtime.sendMessage(
      config
        ? { type: "watch:config", ...config }
        : { type: "watch:stop" },
    );
  } catch {
    // No receiver means the document is not up; ensureWatcher will recreate it.
  }
}

// Keep the document in step when the popup changes the list or the setting.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (WATCH_KEY in changes || ENABLED_KEY in changes) {
    void (async () => {
      const config = await readWatchConfig();
      if (!config) {
        await pushConfig();
        await stopWatcher();
      } else {
        await ensureWatcher();
        await pushConfig();
      }
    })();
  }
});

async function setBadge(unseen: number): Promise<void> {
  await chrome.action.setBadgeText({ text: unseen > 0 ? String(unseen) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#00A8E0" });
}

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    if (details.reason === "install") {
      // Only fill gaps: an update must never overwrite the user's settings.
      const existing = await chrome.storage.local.get(null);
      const missing: Record<string, string> = {};
      for (const [key, value] of Object.entries(DEFAULTS)) {
        if (!(key in existing)) missing[key] = value;
      }
      if (Object.keys(missing).length > 0) await chrome.storage.local.set(missing);
    }
    await ensureWatcher();
  })();
});

// A browser restart tears the offscreen document down with everything else.
chrome.runtime.onStartup.addListener(() => {
  void ensureWatcher();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    const type = (message as { type?: string })?.type;
    switch (type) {
      case "watch:start": {
        const ok = await ensureWatcher();
        if (ok) await pushConfig();
        sendResponse({ ok });
        break;
      }
      case "watch:hello": {
        // The offscreen document asking what to watch (it cannot read storage).
        const config = await readWatchConfig();
        sendResponse(config ? { ...config } : { endpoint: null, scripthashes: null });
        break;
      }
      case "watch:stop": {
        await stopWatcher();
        sendResponse({ ok: true });
        break;
      }
      case "watch:activity": {
        // Something changed: remember when, count it, and light the badge. The
        // popup clears the badge when it opens.
        const at = new Date().toISOString();
        const previous = Number(await getLocal(OFFSET_KEY)) || 0;
        const unseen = (Number(await getLocal(BADGE_KEY)) || 0) + 1;
        await chrome.storage.local.set({
          [OFFSET_KEY]: String(Date.now()),
          [BADGE_KEY]: String(unseen),
        });
        await setBadge(unseen);
        console.log(`[worker] activity at ${at} (was ${previous ? new Date(previous).toISOString() : "never"})`);
        sendResponse({ ok: true });
        break;
      }
      case "watch:seen": {
        await chrome.storage.local.set({ [BADGE_KEY]: "0" });
        await setBadge(0);
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  // Keep the channel open for the async work above.
  return true;
});
