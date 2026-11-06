/**
 * USD price of RXD, for display only.
 *
 * IMPORTANT — privacy: this is the only part of the app that contacts a third
 * party that is not an Electrum server. A price request tells the API provider
 * your IP address and that you are using a Radiant wallet. It is therefore
 * opt-out (Settings → "Show USD value"), it sends nothing but the coin id, and
 * it is disclosed in the privacy policy.
 *
 * Prices are cached for a couple of minutes and a stale cached value is used if
 * the network fails, so the UI can show something sensible offline without
 * hammering the API.
 */

import { getItem, setItem } from "./storage";

const CACHE_KEY = "rxd.price.usd";
const CACHE_TTL_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * CoinGecko id for Radiant is `radiant` (verified: /search?query=radiant returns
 * id "radiant", symbol RXD). CoinPaprika uses `rxd-radiant` and is the fallback.
 * They disagree by ~15% because they aggregate different venues, so the UI says
 * which one is in use rather than implying a single truth.
 */
type Source = "coingecko" | "coinpaprika";

interface CachedPrice {
  usd: number;
  at: number;
  source: Source;
}

export interface PriceResult {
  usd: number;
  source: Source;
  /** True when the value came from cache and could not be refreshed. */
  stale: boolean;
}

/** Read the cached price (no network). */
export function readCachedPrice(now = Date.now()): CachedPrice | null {
  try {
    const raw = getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPrice;
    if (!Number.isFinite(parsed?.usd) || parsed.usd <= 0) return null;
    if (typeof parsed.at !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedPrice(entry: CachedPrice): void {
  try {
    setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    /* storage unavailable — the price just won't be cached */
  }
}

async function getJson(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the RXD price in USD.
 *
 * Returns null only when there is neither a fresh fetch nor a cached value.
 * Never throws — a wallet must not break because a price API is down.
 */
export async function fetchRxdUsd(options: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: number;
  /** Ignore the cache (used by the manual refresh). */
  force?: boolean;
} = {}): Promise<PriceResult | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const now = options.now ?? Date.now();

  const cached = readCachedPrice(now);
  if (!options.force && cached && now - cached.at < CACHE_TTL_MS) {
    return { usd: cached.usd, source: cached.source, stale: false };
  }

  // Primary then fallback; both are keyless and public.
  const providers: { source: Source; url: string; pick: (json: any) => number }[] = [
    {
      source: "coingecko",
      url: "https://api.coingecko.com/api/v3/simple/price?ids=radiant&vs_currencies=usd",
      pick: (json) => Number(json?.radiant?.usd),
    },
    {
      source: "coinpaprika",
      url: "https://api.coinpaprika.com/v1/tickers/rxd-radiant",
      pick: (json) => Number(json?.quotes?.USD?.price),
    },
  ];

  for (const provider of providers) {
    try {
      const json = await getJson(provider.url, fetchImpl, timeoutMs);
      const usd = provider.pick(json);
      if (Number.isFinite(usd) && usd > 0) {
        writeCachedPrice({ usd, at: now, source: provider.source });
        return { usd, source: provider.source, stale: false };
      }
    } catch {
      /* try the next provider */
    }
  }

  // Everything failed: a stale number is better than none, clearly marked.
  if (cached) return { usd: cached.usd, source: cached.source, stale: true };
  return null;
}

const PHOTONS_PER_RXD = 100_000_000;

/**
 * Format a photon balance as USD.
 *
 * RXD trades around $0.00003, so a normal personal balance is worth cents. Below
 * one cent the UI says "< $0.01" rather than printing $0.003, which reads like a
 * rounding error.
 */
export function formatUsdBalance(photons: bigint, usdPerRxd: number): string {
  if (!Number.isFinite(usdPerRxd) || usdPerRxd <= 0) return "";
  const rxd = Number(photons) / PHOTONS_PER_RXD;
  const usd = rxd * usdPerRxd;
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "< $0.01";
  return `$${usd.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Format the unit price, e.g. `$0.0000286`. */
export function formatUsdPrice(usdPerRxd: number): string {
  if (!Number.isFinite(usdPerRxd) || usdPerRxd <= 0) return "";
  if (usdPerRxd >= 1) return `$${usdPerRxd.toFixed(2)}`;
  if (usdPerRxd >= 0.01) return `$${usdPerRxd.toFixed(4)}`;
  return `$${usdPerRxd.toPrecision(3)}`;
}

const FIAT_KEY = "rxd.fiat.enabled";

/** Whether to show fiat values. On by default; it is disclosed in Settings. */
export function loadFiatEnabled(): boolean {
  try {
    return getItem(FIAT_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveFiatEnabled(enabled: boolean): void {
  try {
    setItem(FIAT_KEY, enabled ? "1" : "0");
  } catch {
    /* ignore storage failure */
  }
}
