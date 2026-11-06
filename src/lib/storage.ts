/**
 * Persistence for the extension.
 *
 * The Android build used `localStorage`: synchronous, and always present in a
 * WebView. Neither is true in an MV3 extension. `localStorage` does not exist in a
 * service worker, and extension state belongs in `chrome.storage.local` so that
 * every extension page shares one copy that survives a browser restart.
 *
 * `chrome.storage` is asynchronous, but the wallet reads several preferences
 * synchronously while rendering (is there a vault? which server? is the price
 * display on?). Rather than turn every call site into an async state machine, this
 * module keeps an in-memory mirror with the same synchronous shape as localStorage:
 *
 *   • `hydrate()` fills the mirror once, before React mounts;
 *   • `getItem` / `setItem` / `removeItem` behave like their localStorage namesakes;
 *   • writes go through to chrome.storage, and `onChanged` keeps the mirror honest
 *     if another extension page writes at the same time.
 *
 * Outside an extension (`npm run dev`, and the Node test harness) there is no
 * chrome API, so an in-memory store is used instead. Nothing persists there, which
 * is exactly what tests want.
 */

interface StorageArea {
  get(keys: null | string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

const mirror = new Map<string, string>();

let area: StorageArea | null = null;
let hydration: Promise<void> | null = null;

/** Wrap `chrome.storage.local`, or return null when it is not there. */
function detectArea(): StorageArea | null {
  const api = (globalThis as { chrome?: typeof chrome }).chrome?.storage?.local;
  if (!api) return null;
  return {
    get: (keys) => api.get(keys) as Promise<Record<string, unknown>>,
    set: (items) => api.set(items) as Promise<void>,
    remove: (key) => api.remove(key) as Promise<void>,
  };
}

function applyChanges(changes: Record<string, { newValue?: unknown }>): void {
  for (const [key, change] of Object.entries(changes)) {
    if (typeof change.newValue === "string") mirror.set(key, change.newValue);
    else mirror.delete(key);
  }
}

/**
 * Load persisted values into the mirror. Must be awaited before the first render:
 * otherwise a returning user is shown the onboarding screen for a frame and could
 * try to create a second wallet on top of an existing vault.
 */
export function hydrate(): Promise<void> {
  if (hydration) return hydration;
  hydration = (async () => {
    area = detectArea();
    if (!area) return;
    const stored = await area.get(null);
    for (const [key, value] of Object.entries(stored)) {
      if (typeof value === "string") mirror.set(key, value);
    }
    (globalThis as { chrome?: typeof chrome }).chrome?.storage?.onChanged?.addListener(
      (changes, areaName) => {
        if (areaName === "local") applyChanges(changes);
      },
    );
  })();
  return hydration;
}

export function getItem(key: string): string | null {
  const value = mirror.get(key);
  return value === undefined ? null : value;
}

export function setItem(key: string, value: string): void {
  mirror.set(key, value);
  // Fire-and-forget: a quota failure must not break signing or rendering. The
  // mirror keeps this session working even if persistence fails.
  void area?.set({ [key]: value }).catch((err: unknown) => {
    console.error(`could not persist ${key}`, err);
  });
}

export function removeItem(key: string): void {
  mirror.delete(key);
  void area?.remove(key).catch((err: unknown) => {
    console.error(`could not remove ${key}`, err);
  });
}

/** Test hook: drop all state so a fresh scenario starts clean. */
export function __resetForTests(): void {
  mirror.clear();
  area = null;
  hydration = null;
}

/** True when running inside a real extension (as opposed to tests or `npm run dev`). */
export function hasChromeStorage(): boolean {
  return area !== null;
}
