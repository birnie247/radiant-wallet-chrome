/**
 * The unlocked session.
 *
 * A browser popup is destroyed every time it loses focus, so React state cannot
 * carry an unlock across "click anywhere outside the popup". Keeping the secret in
 * `chrome.storage.session` is the standard answer: Chrome documents that area as
 * **memory-only**, never written to disk, and cleared when the browser closes.
 *
 * That is a deliberate trade-off and it is the user's to make:
 *
 *   • default is 5 minutes, so reopening the popup is not a passphrase prompt;
 *   • Settings can set it to *Immediately*, which stores nothing at all and gives
 *     the same behaviour as the Android build's default (unlock every time).
 *
 * What is stored is the same `WalletSecrets` the passphrase unlock produces, in the
 * clear — the encrypted vault remains the source of truth and is what survives a
 * restart. Reading it back validates the shape, because a half-written or older
 * entry should force a passphrase unlock rather than half-initialise a session.
 */
import type { WalletSecrets } from "./vault";
import { getItem, setItem } from "./storage";

const SESSION_KEY = "rxd.session.unlocked";
const TIMEOUT_KEY = "rxd.session.timeoutMs";

/** Selectable unlock windows. 0 means "lock immediately". */
export const UNLOCK_TIMEOUT_OPTIONS: readonly { ms: number; label: string }[] = [
  { ms: 0, label: "Immediately" },
  { ms: 60_000, label: "1 min" },
  { ms: 5 * 60_000, label: "5 min" },
  { ms: 15 * 60_000, label: "15 min" },
  { ms: 60 * 60_000, label: "1 hour" },
];

export const UNLOCK_TIMEOUT_OPTIONS_MS: readonly number[] =
  UNLOCK_TIMEOUT_OPTIONS.map((option) => option.ms);

export const DEFAULT_UNLOCK_TIMEOUT_MS = 5 * 60_000;

/** Human wording for the chosen window, used in Settings. */
export function describeUnlockTimeout(ms: number): string {
  return UNLOCK_TIMEOUT_OPTIONS.find((option) => option.ms === ms)?.label ??
    `${Math.round(ms / 60_000)} min`;
}

/** Reject anything that is not one of the offered values (a tampered store, or an
 *  older build's setting) rather than honouring an arbitrary lifetime.
 *
 *  Note the deliberate distinction between "missing" and "0": 0 is a valid
 *  setting ("lock immediately"), so it must not be conflated with an absent
 *  value. `Number(null)` and `Number("")` are both 0, which would silently turn a
 *  fresh install into the most aggressive lock — hence the explicit guard. */
export function parseUnlockTimeoutMs(raw: string | null): number {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return DEFAULT_UNLOCK_TIMEOUT_MS;
  }
  const value = Number(raw);
  return UNLOCK_TIMEOUT_OPTIONS_MS.includes(value)
    ? value
    : DEFAULT_UNLOCK_TIMEOUT_MS;
}

export function loadUnlockTimeoutMs(): number {
  return parseUnlockTimeoutMs(getItem(TIMEOUT_KEY));
}

export function saveUnlockTimeoutMs(ms: number): void {
  setItem(TIMEOUT_KEY, String(parseUnlockTimeoutMs(String(ms))));
}

interface SessionBox {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** `chrome.storage.session` when available; otherwise process memory. */
function sessionBox(): SessionBox | null {
  const api = (globalThis as { chrome?: typeof chrome }).chrome?.storage?.session;
  if (!api) return null;
  return {
    get: (key) => api.get(key) as Promise<Record<string, unknown>>,
    set: (items) => api.set(items) as Promise<void>,
    remove: (key) => api.remove(key) as Promise<void>,
  };
}

/** Fallback used outside an extension (dev server, tests). */
let memorySession: { secrets: WalletSecrets; expiresAt: number } | null = null;

interface StoredSession {
  secrets: WalletSecrets;
  expiresAt: number;
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredSession>;
  return (
    typeof candidate.expiresAt === "number" &&
    !!candidate.secrets &&
    typeof candidate.secrets === "object" &&
    typeof candidate.secrets.mnemonic === "string" &&
    candidate.secrets.mnemonic.length > 0
  );
}

/**
 * Persist the unlocked secret for `ttlMs`. A ttl of 0 stores nothing, so the next
 * popup open requires the passphrase.
 */
export async function saveSession(secrets: WalletSecrets, ttlMs: number): Promise<void> {
  if (ttlMs <= 0) {
    await clearSession();
    return;
  }
  const payload: StoredSession = { secrets, expiresAt: Date.now() + ttlMs };
  const box = sessionBox();
  if (!box) {
    memorySession = payload;
    return;
  }
  await box.set({ [SESSION_KEY]: payload });
}

/** The unlocked secret, or null when absent, expired or malformed. */
export async function loadSession(): Promise<WalletSecrets | null> {
  const box = sessionBox();
  let stored: unknown;
  if (!box) {
    stored = memorySession;
  } else {
    const values = await box.get(SESSION_KEY);
    stored = values[SESSION_KEY];
  }
  if (!isStoredSession(stored)) {
    if (stored !== undefined && box) await box.remove(SESSION_KEY);
    return null;
  }
  if (stored.expiresAt <= Date.now()) {
    await clearSession();
    return null;
  }
  return stored.secrets;
}

export async function clearSession(): Promise<void> {
  memorySession = null;
  const box = sessionBox();
  if (box) await box.remove(SESSION_KEY);
}
