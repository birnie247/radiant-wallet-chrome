/**
 * What the background watcher is allowed to know.
 *
 * The popup holds the keys; the background must not. So when a wallet is unlocked
 * the popup hands over only what is already public: the endpoint and the
 * scripthashes of the addresses worth watching. That list is what lets the
 * extension notice an incoming payment while the popup is closed without the
 * service worker or the offscreen document ever touching a private key.
 *
 * Addresses are on the public chain, so storing these in `chrome.storage.local`
 * (unencrypted) discloses nothing that a block explorer would not. The mnemonic is
 * never part of this structure.
 */
import { addressToScriptHash } from "@radiant-core/sdk";
import { getItem, removeItem, setItem } from "./storage";
import { DEFAULT_LOOKAHEAD, watchTargets } from "./liveUpdates";
import type { ScannedAddress } from "./wallet";

const WATCH_KEY = "rxd.watch.list";
const ENABLED_KEY = "rxd.watch.enabled";

export interface WatchList {
  /** Server to watch against, e.g. wss://electrumx.radiant4people.com:50022 */
  endpoint: string;
  /** ElectrumX scripthashes, hex. */
  scripthashes: string[];
  /** The addresses they came from, for diagnostics and the UI. */
  addresses: string[];
  savedAt: number;
}

/** Build the watch list a completed scan implies. */
export function buildWatchList(
  endpoint: string,
  addresses: ScannedAddress[],
  lookahead = DEFAULT_LOOKAHEAD,
): WatchList {
  // Same targets the foreground subscribes to, so background and foreground agree
  // about which addresses count as "ours".
  const watched = watchTargets(addresses, lookahead);
  return {
    endpoint,
    addresses: watched,
    scripthashes: watched.map((address) => addressToScriptHash(address, "mainnet")),
    savedAt: Date.now(),
  };
}

export function saveWatchList(list: WatchList): void {
  setItem(WATCH_KEY, JSON.stringify(list));
}

/** The stored list, or null when absent or unparseable. */
export function loadWatchList(): WatchList | null {
  const raw = getItem(WATCH_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WatchList>;
    if (
      typeof parsed.endpoint !== "string" ||
      !parsed.endpoint.startsWith("wss://") ||
      !Array.isArray(parsed.scripthashes) ||
      parsed.scripthashes.length === 0 ||
      !parsed.scripthashes.every((s) => typeof s === "string" && /^[0-9a-f]{64}$/i.test(s))
    ) {
      return null;
    }
    return {
      endpoint: parsed.endpoint,
      scripthashes: parsed.scripthashes,
      addresses: Array.isArray(parsed.addresses) ? (parsed.addresses as string[]) : [],
      savedAt: Number(parsed.savedAt) || 0,
    };
  } catch {
    return null;
  }
}

export function clearWatchList(): void {
  removeItem(WATCH_KEY);
}

/** Background watching is on unless the user turns it off. */
export function loadWatchEnabled(): boolean {
  return getItem(ENABLED_KEY) !== "0";
}

export function saveWatchEnabled(enabled: boolean): void {
  setItem(ENABLED_KEY, enabled ? "1" : "0");
}
