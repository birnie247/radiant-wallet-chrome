/**
 * ElectrumX endpoints for Radiant, and the servers the user adds to them.
 *
 * Transport: the Radiant SDK speaks ElectrumX over **WebSocket** JSON-RPC, so
 * every endpoint here is `wss://` AND on a WebSocket port. The two are easy to
 * confuse: on 2026-11-06 `electrumx.radiantcore.org` answered `server.version`
 * on :50012 over raw TLS + line protocol, while :50001-:50004 and :50022 were
 * closed on it - the usable endpoint was `wss://electrumx.radiantcore.org:443`.
 * A host that "answers on 50012" is therefore not usable here: a browser
 * WebSocket cannot speak the line protocol, it fails the HTTP upgrade.
 *
 * Plain `ws://` is refused everywhere. An extension page is a secure context, so
 * Chrome blocks an insecure WebSocket as mixed content; offering it would only
 * produce a confusing failure.
 *
 * The historical 50001/50002 hosts (`electrum.radiant.ovh`,
 * `electrum.radiantblockchain.org`) are dead - neither hostname resolves - and
 * `electrumx.radiant.ovh`, `electrumx.radiantexplorer.com` and
 * `electrumx2.radiantexplorer.com` no longer serve a WebSocket port. Do not
 * reintroduce any of them.
 *
 * Trust model (security report MEDIUM-2):
 *   - Every endpoint is `wss://` with a hostname, so the TLS certificate is
 *     actually verifiable. A bare-IP endpoint was REMOVED: an IP cannot match a
 *     certificate identity, which silently degrades to "trust the network".
 *   - `operator` groups endpoints that share an administrator. Cross-checking two
 *     servers from the same operator proves nothing, so quorum logic (see
 *     crossCheckTip in wallet.ts) only counts distinct operators.
 *   - `verified` is not a UI label - connect() tries verified servers first and
 *     only falls back to unverified ones. Both flags describe the node operator,
 *     not the chain.
 *
 * Merkle proofs are verified against headers (see src/lib/spv.ts), but proof of
 * work only back to this build checkpoint, and the difficulty-adjustment rule is
 * not checked. Treat the Electrum server as a semi-trusted view of the chain.
 *
 * The list below is the CURATED DEFAULT, not a policy: Settings lets the user add
 * an endpoint of their own and remove any entry (see "User-managed servers").
 */
import type { NetworkName } from "@radiant-core/sdk";
import { getItem, removeItem, setItem } from "./storage";

export interface ServerEntry {
  url: string;
  /** Administrator grouping; quorum requires distinct operators. */
  operator: string;
  /**
   * True only for endpoints that answered a live `server.version` handshake.
   * These are the ones `connect()` will try on its own - see autoCandidates().
   */
  verified: boolean;
  /** Added by the user in Settings rather than curated in this file. */
  custom?: boolean;
}
/**
 * Last live probe: 2026-11-08, the same one the Android build pins. All four
 * mainnet endpoints below completed a `server.version` handshake and reported
 * Radiant genesis. On 2026-11-06 the tips were 479,536 / 479,536 / 479,538 - the
 * radiantcore.org peer was two blocks ahead, so none of them was stale.
 *
 * `wss://rxdexplorer.com` is deliberately FIRST: it is the default a fresh install
 * lands on, so it is the endpoint most users will actually talk to. On 2026-11-08
 * it answered in 315 ms as `ElectrumX 1.4.1` at height 480,110, with a valid
 * Let's Encrypt certificate (CN=rxdexplorer.com, chain verified, expires
 * 2027-02-05) and a `genesis_hash` equal to GENESIS_HASH in spv.ts. It listens on
 * :443 only - `:50022` times out.
 *
 * It is operated by this wallet's maintainer, so its `operator` value is a known
 * fact rather than the hostname guess used for user-added servers. That is also why
 * the tip cross-check still earns its keep: this server is compared against
 * radiant4people.com and radiantcore.org, neither of which the maintainer has any
 * part in. A user who wants to trust nothing connected to this project can press
 * Use on either of those in Settings.
 *
 * Removed on 2026-11-06:
 *   - `radiant2/radiantus/radiant4.bladenet.online:50022` - all three timed out.
 *   - `wss://radiantcore.org:50004` - that host serves WebSocket on :443 only.
 *
 * If a listed endpoint dies, flag it `verified: false` instead of deleting it: it
 * drops out of the automatic connect order (see autoCandidates) but stays
 * selectable in Settings, so a dead host can never add ~7s of silence to every
 * connection attempt.
 */
export const SERVERS: Record<NetworkName, ServerEntry[]> = {
  mainnet: [
    {
      url: "wss://rxdexplorer.com",
      operator: "rxdexplorer.com",
      verified: true,
    },
    {
      url: "wss://electrumx.radiant4people.com:50022",
      operator: "radiant4people.com",
      verified: true,
    },
    {
      url: "wss://electrumx2.radiant4people.com:50022",
      operator: "radiant4people.com",
      verified: true,
    },
    {
      url: "wss://electrumx.radiantcore.org:443",
      operator: "radiantcore.org",
      verified: true,
    },
    // NOTE: the bare-IP endpoint wss://82.180.136.182:50004 was removed (see the
    // trust-model note above). That IP is still current - it is what both
    // radiantcore.org and electrumx.radiantcore.org resolve to - but only the
    // hostname form has a certificate that can actually be verified.
    // The three *.bladenet.online endpoints were removed on 2026-11-06: all of
    // them timed out, and they were never verified.
  ],
  // Testnet support was removed: every testnet endpoint is gone.
  // electrumx-testnet.radiant4people.com refuses connections and
  // testnet.bladenet.online no longer resolves, so offering the network only
  // produced a confusing failure. The wallet is mainnet-only.
  testnet: [],
  regtest: [],
};

/**
 * ---------------------------------------------------------------------------
 * User-managed servers
 *
 * Storage rules, and why:
 *   - Both lists live in chrome.storage.local, NOT in the encrypted vault. A
 *     server address is not a secret, and changing servers must never ask for the
 *     passphrase - the same reason PREFERRED_KEY lives here.
 *   - Removing a CURATED endpoint only records it as hidden, so
 *     restoreHiddenServers() brings the defaults back without a rebuild.
 *   - Everything read back from storage is re-validated. A corrupt or hostile
 *     entry must not be able to inject `ws://` or a URL with a path that no
 *     client would ever reach.
 *   - `verified` on a custom entry is a MEASUREMENT - the result of the last
 *     `server.version` handshake - not a promise about who runs the box.
 *   - The last remaining endpoint cannot be removed: a wallet with no server
 *     could never connect again.
 * ---------------------------------------------------------------------------
 */
const CUSTOM_KEY = "rxd.wallet.customServers.v1";
const HIDDEN_KEY = "rxd.wallet.hiddenServers.v1";

/** What we persist for a user-added endpoint. */
interface StoredCustomServer {
  url: string;
  /** True only if the server answered a `server.version` handshake. */
  verified: boolean;
  addedAt: number;
  testedAt: number;
}

/** Storage is keyed by network, so future testnet lists stay separate. */
type PerNetwork<T> = Partial<Record<NetworkName, T>>;

function readMap<T>(key: string): PerNetwork<T> {
  try {
    const raw = getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as PerNetwork<T>;
  } catch {
    /* corrupt JSON, or storage unavailable - behave as if nothing was stored */
    return {};
  }
}

function writeMap<T>(key: string, value: PerNetwork<T>): void {
  try {
    setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the change still applies to this session */
  }
}
/** Readable host for messages: `wss://[::1]:50022` -> `[::1]`. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.replace(/^wss?:\/\//, "").split(/[:/]/)[0].toLowerCase();
  }
}

/**
 * Validate and normalise a server address typed by the user.
 *
 * Returns the canonical `wss://host[:port]` form, or a sentence the UI can show
 * as-is. `wss://host:443` normalises to `wss://host` (443 is the wss default),
 * which is what makes duplicate detection work when someone pastes a URL that
 * spells the default port out.
 */
export function parseServerUrl(
  raw: string,
): { url: string } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      error: "Enter a server address, e.g. wss://electrumx.example.org:50022.",
    };
  }
  if (trimmed.length > 200) {
    return { error: "That address is too long." };
  }
  // A bare host is the most common paste, so assume wss:// rather than scolding
  // the user - it is the only scheme this client can use anyway.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `wss://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return {
      error:
        "That isn't a valid address - expected something like wss://host:50022.",
    };
  }

  if (parsed.protocol === "ws:") {
    return {
      error:
        "Use wss:// rather than ws:// - an extension page is a secure context, so Chrome blocks a plain ws:// socket as mixed content.",
    };
  }
  if (parsed.protocol !== "wss:") {
    return { error: `Only wss:// endpoints work here (got ${parsed.protocol}//).` };
  }
  if (!parsed.hostname) {
    return { error: "The address has no host name." };
  }
  if (parsed.username || parsed.password) {
    return {
      error: "Remove the credentials - ElectrumX over WebSocket takes none.",
    };
  }
  if (parsed.port) {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: "The port must be a number between 1 and 65535." };
    }
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    return { error: "ElectrumX answers at the root of the host - remove the path." };
  }
  if (parsed.search || parsed.hash) {
    return { error: "Remove the query string and fragment." };
  }

  return { url: `wss://${parsed.host.toLowerCase()}` };
}

/**
 * Canonical form used for every comparison (dedupe, "is this in use", "is the
 * preferred server still listed"). Strings that no longer parse fall back to a
 * lowercase trim, so a stale stored value can still be matched and deleted
 * instead of becoming immortal.
 */
export function canonicalServerUrl(url: string): string {
  const parsed = parseServerUrl(url);
  return "url" in parsed ? parsed.url : url.trim().toLowerCase();
}
export function serverList(network: NetworkName): string[] {
  return allServers(network).map((s) => s.url);
}

function storedCustom(network: NetworkName): StoredCustomServer[] {
  const list = readMap<StoredCustomServer[]>(CUSTOM_KEY)[network];
  if (!Array.isArray(list)) return [];

  const seen = new Set<string>();
  const out: StoredCustomServer[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const parsed = parseServerUrl(typeof raw.url === "string" ? raw.url : "");
    // Re-validate: storage is not trusted, and an entry that no longer parses
    // would otherwise linger as an unreachable, undeletable row.
    if (!("url" in parsed)) continue;
    if (seen.has(parsed.url)) continue;
    seen.add(parsed.url);
    out.push({
      url: parsed.url,
      verified: raw.verified === true,
      addedAt: Number(raw.addedAt) || 0,
      testedAt: Number(raw.testedAt) || 0,
    });
  }
  return out;
}

function storedHidden(network: NetworkName): string[] {
  const list = readMap<string[]>(HIDDEN_KEY)[network];
  if (!Array.isArray(list)) return [];
  return list.filter((url): url is string => typeof url === "string");
}

/** Endpoints the user added. */
export function customServers(network: NetworkName): ServerEntry[] {
  return storedCustom(network).map((entry) => ({
    url: entry.url,
    // A user-added host is its own operator: the app cannot know who runs it, and
    // collapsing them all into "custom" would quietly break the tip cross-check,
    // which only counts distinct operators.
    operator: hostOf(entry.url),
    verified: entry.verified,
    custom: true,
  }));
}

/** Curated endpoints the user removed - hidden, restorable, not deleted. */
export function hiddenServers(network: NetworkName): string[] {
  const hidden = new Set(storedHidden(network).map(canonicalServerUrl));
  return SERVERS[network]
    .filter((server) => hidden.has(canonicalServerUrl(server.url)))
    .map((server) => server.url);
}

/**
 * Everything currently on offer for a network: curated entries the user has not
 * hidden, then the ones they added. Settings lists this, and every candidate
 * helper below reads it, so a removal takes effect everywhere at once.
 */
export function allServers(network: NetworkName): ServerEntry[] {
  const hidden = new Set(storedHidden(network).map(canonicalServerUrl));
  const curated = SERVERS[network].filter(
    (server) => !hidden.has(canonicalServerUrl(server.url)),
  );
  const curatedUrls = new Set(
    curated.map((server) => canonicalServerUrl(server.url)),
  );
  // Drop a custom entry that duplicates a visible curated one: findServer takes
  // the first match, so the duplicate would be listed but unreachable.
  const custom = customServers(network).filter(
    (server) => !curatedUrls.has(canonicalServerUrl(server.url)),
  );
  return [...curated, ...custom];
}

export function findServer(
  network: NetworkName,
  url: string,
): ServerEntry | undefined {
  const canon = canonicalServerUrl(url);
  return allServers(network).find(
    (server) => canonicalServerUrl(server.url) === canon,
  );
}
/**
 * Add a user-supplied endpoint.
 *
 * Throws a user-facing message when the address is invalid or already listed -
 * Settings shows it verbatim, so the text is written for the person typing.
 */
export function addCustomServer(
  network: NetworkName,
  raw: string,
  options: { verified?: boolean; testedAt?: number } = {},
): ServerEntry {
  const parsed = parseServerUrl(raw);
  if ("error" in parsed) throw new Error(parsed.error);

  const url = parsed.url;
  const canon = canonicalServerUrl(url);
  if (allServers(network).some((s) => canonicalServerUrl(s.url) === canon)) {
    throw new Error("That server is already in the list.");
  }

  const verified = options.verified === true;
  const now = Date.now();
  const map = readMap<StoredCustomServer[]>(CUSTOM_KEY);
  map[network] = storedCustom(network).concat({
    url,
    verified,
    addedAt: now,
    testedAt: verified ? (options.testedAt ?? now) : 0,
  });
  writeMap(CUSTOM_KEY, map);

  return { url, operator: hostOf(url), verified, custom: true };
}

/** Record the outcome of a handshake test against a user-added endpoint. */
export function setCustomServerVerified(
  network: NetworkName,
  url: string,
  verified: boolean,
): void {
  const canon = canonicalServerUrl(url);
  const list = storedCustom(network);
  if (!list.some((entry) => canonicalServerUrl(entry.url) === canon)) return;
  const map = readMap<StoredCustomServer[]>(CUSTOM_KEY);
  map[network] = list.map((entry) =>
    canonicalServerUrl(entry.url) === canon
      ? { ...entry, verified, testedAt: verified ? Date.now() : entry.testedAt }
      : entry,
  );
  writeMap(CUSTOM_KEY, map);
}

/**
 * Remove an endpoint.
 *
 * A user-added entry is deleted; a curated one is hidden (see hiddenServers) so
 * the defaults stay restorable. The preferred server is cleared when it is the
 * one being removed, so the app can never keep pointing at something the user
 * just deleted.
 */
export function removeServer(network: NetworkName, url: string): void {
  const canon = canonicalServerUrl(url);
  const remaining = allServers(network).filter(
    (server) => canonicalServerUrl(server.url) !== canon,
  );
  if (remaining.length === 0) {
    throw new Error(
      "Keep at least one server - add another one before removing this.",
    );
  }

  const isCustom = customServers(network).some(
    (server) => canonicalServerUrl(server.url) === canon,
  );
  if (isCustom) {
    const map = readMap<StoredCustomServer[]>(CUSTOM_KEY);
    map[network] = storedCustom(network).filter(
      (entry) => canonicalServerUrl(entry.url) !== canon,
    );
    writeMap(CUSTOM_KEY, map);
  } else {
    const hidden = new Set(storedHidden(network).map(canonicalServerUrl));
    hidden.add(canon);
    const map = readMap<string[]>(HIDDEN_KEY);
    map[network] = [...hidden];
    writeMap(HIDDEN_KEY, map);
  }

  const preferred = getPreferredServer();
  if (preferred && canonicalServerUrl(preferred) === canon) setPreferredServer("");
}

/** Un-hide every curated endpoint the user removed. */
export function restoreHiddenServers(network: NetworkName): void {
  const map = readMap<string[]>(HIDDEN_KEY);
  if (network in map) {
    delete map[network];
    writeMap(HIDDEN_KEY, map);
  }

  // A user-added entry that duplicated a hidden curated one is now shadowed: the
  // restored default wins in allServers(), so the stored copy would linger
  // invisibly and could never be removed again. Drop it, keeping the store and
  // the list in agreement.
  const curated = new Set(SERVERS[network].map((s) => canonicalServerUrl(s.url)));
  const customs = storedCustom(network);
  const kept = customs.filter(
    (entry) => !curated.has(canonicalServerUrl(entry.url)),
  );
  if (kept.length === customs.length) return;
  const customMap = readMap<StoredCustomServer[]>(CUSTOM_KEY);
  if (kept.length === 0) delete customMap[network];
  else customMap[network] = kept;
  writeMap(CUSTOM_KEY, customMap);
}
/**
 * Ordered candidates for the Settings list and for probing: everything we know
 * about - curated verified, then anything the user added, then curated entries we
 * could not verify. `connect()` uses autoCandidates instead, which omits the dead
 * ones.
 */
export function candidateServers(
  network: NetworkName,
  preferred?: string,
): string[] {
  const all = allServers(network);
  const ordered = [
    ...all.filter((s) => !s.custom && s.verified),
    ...all.filter((s) => s.custom),
    ...all.filter((s) => !s.custom && !s.verified),
  ];
  const urls = ordered.map((s) => s.url);
  if (!preferred) return urls;
  return [preferred, ...urls.filter((u) => u !== preferred)];
}

/**
 * Endpoints worth trying automatically, in order: the user's explicit choice
 * (they may have picked a host we consider unverified), then the curated verified
 * endpoints, then anything the user added themselves.
 *
 * If a network has NO verified curated endpoint at all the whole list is used,
 * because a slow failure is better than refusing to try. With testnet removed that
 * branch is effectively unreachable today, but it keeps the behaviour sane if every
 * curated endpoint on a network is ever downgraded at once.
 *
 * User-added endpoints sit AFTER the curated ones on purpose: a server the user
 * has not activated in Settings is a fallback, not the default, and a dead custom
 * host must never add silence to every connection attempt while a known-good
 * curated host is available.
 */
export function autoCandidates(
  network: NetworkName,
  preferred?: string,
): string[] {
  const all = allServers(network);
  const verifiedCurated = all
    .filter((s) => !s.custom && s.verified)
    .map((s) => s.url);
  const custom = all.filter((s) => s.custom).map((s) => s.url);
  const rest = all
    .filter((s) => !s.custom && !s.verified)
    .map((s) => s.url);
  const pool =
    verifiedCurated.length > 0
      ? [...verifiedCurated, ...custom]
      : [...custom, ...rest];
  if (!preferred) return pool;
  return [preferred, ...pool.filter((u) => u !== preferred)];
}

/**
 * Endpoints run by a DIFFERENT operator than `endpoint` - the raw pool for an
 * independent cross-check. Verified endpoints are ordered first, but unverified
 * ones are included: a cross-check only compares chain heights, it never trusts the
 * peer data. Including them means the check can still detect disagreement when the
 * curated peers are offline. If every candidate is down the check simply returns
 * null and no warning is shown (better than a false alarm).
 *
 * Note this returns *every* endpoint from those operators, so two hosts behind one
 * administrator both appear. Use {@link crossCheckCandidates} when you need
 * independent opinions rather than a list of alternatives.
 */
export function independentServers(
  network: NetworkName,
  endpoint: string,
): ServerEntry[] {
  const primary = findServer(network, endpoint);
  const canon = canonicalServerUrl(endpoint);
  const others = allServers(network).filter(
    (s) => canonicalServerUrl(s.url) !== canon && s.operator !== primary?.operator,
  );
  return [
    ...others.filter((s) => s.verified),
    ...others.filter((s) => !s.verified),
  ];
}

/**
 * Up to `limit` peers for a tip cross-check, each from a DIFFERENT operator -
 * different from the primary's and from each other's.
 *
 * Taking the first N of {@link independentServers} is not quorum, it is a list:
 * with `rxdexplorer.com` as the default primary, the first two candidates were both
 * radiant4people.com entries, so a failure on the first bought nothing on the second
 * - the same administrator simply answered twice. Deduping by operator makes the
 * second peer an actual second opinion, which is the whole point of the check
 * (security report MEDIUM-2).
 */
export function crossCheckCandidates(
  network: NetworkName,
  endpoint: string,
  limit = 2,
): ServerEntry[] {
  const picked: ServerEntry[] = [];
  const operators = new Set<string>();
  for (const entry of independentServers(network, endpoint)) {
    if (operators.has(entry.operator)) continue;
    operators.add(entry.operator);
    picked.push(entry);
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * The user's chosen server is NOT a secret, so it lives outside the encrypted
 * vault - that way switching servers never requires the passphrase.
 */
const PREFERRED_KEY = "rxd.wallet.preferredServer";

export function getPreferredServer(): string | null {
  try {
    return getItem(PREFERRED_KEY);
  } catch {
    return null;
  }
}

export function setPreferredServer(url: string): void {
  try {
    if (url) setItem(PREFERRED_KEY, url);
    else removeItem(PREFERRED_KEY);
  } catch {
    /* storage may be unavailable */
  }
}