/**
 * Live balance updates via ElectrumX push subscriptions.
 *
 * Rather than polling, we subscribe to the scripthashes we care about: the
 * server sends a notification the moment the output set for an address changes,
 * which is what makes a received payment appear within a second or two of the
 * mempool/block update, with no extra traffic while nothing happens.
 *
 * The wallet's addresses are already revealed to the server by the gap-limit
 * scan, so subscribing adds no new exposure in kind.
 *
 * Two guards matter here:
 *
 *   • SETTLE WINDOW — a fresh subscription must not immediately trigger a
 *     re-scan. Some servers answer the subscribe request with the current status
 *     as a notification; treating that as news would put the app in a
 *     scan→resubscribe→scan loop. Notifications in the first second are ignored,
 *     and nothing is lost because the scan that established the subscription had
 *     just read the same state.
 *   • DEBOUNCE — one incoming transaction usually touches several of our
 *     addresses (payment + change), and a burst of notifications must produce
 *     one re-scan, not one per address.
 *
 * A single address failing to subscribe never breaks the others: a server may
 * cap subscriptions, and the rest still work.
 */
import type { ScannedAddress } from "./wallet";

/** Structural subset of ElectrumClient — lets tests pass a fake. */
export interface AddressWatcher {
  subscribe(
    addressOrScriptHash: string,
    onUpdate: (status: string | null) => void,
  ): Promise<string | null>;
  unsubscribe(addressOrScriptHash: string): Promise<unknown>;
}

export interface WatchOptions {
  /** Also watch this many unused addresses, to catch the next payment. */
  lookahead?: number;
  /** Coalesce a burst of notifications into one callback. */
  debounceMs?: number;
  /** Ignore notifications this soon after subscribing (see SETTLE WINDOW). */
  settleMs?: number;
}

export interface WatchHandle {
  /** Addresses the server accepted a subscription for. */
  subscribed: string[];
  /** Addresses the server refused (or that failed mid-way). */
  failed: string[];
  /** Stop receiving updates. Safe to call more than once. */
  dispose: () => Promise<void>;
}

export const DEFAULT_LOOKAHEAD = 3;
export const DEFAULT_DEBOUNCE_MS = 800;
export const DEFAULT_SETTLE_MS = 1_000;

/** Which addresses are worth watching, given a completed scan. */
export function watchTargets(
  addresses: ScannedAddress[],
  lookahead = DEFAULT_LOOKAHEAD,
): string[] {
  const used = addresses.filter((a) => a.used).map((a) => a.key.address);
  // Watch a few addresses past the last used one so the next payment to a fresh
  // address also shows up without a manual refresh.
  const unused = addresses.filter((a) => !a.used).map((a) => a.key.address);
  return [...used, ...unused.slice(0, lookahead)];
}

/**
 * Subscribe to the wallet's addresses.
 * `onChange` is debounced, so callers can re-scan unconditionally.
 */
export async function watchWalletAddresses(
  client: AddressWatcher,
  addresses: ScannedAddress[],
  onChange: () => void,
  options: WatchOptions = {},
): Promise<WatchHandle> {
  const {
    lookahead = DEFAULT_LOOKAHEAD,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    settleMs = DEFAULT_SETTLE_MS,
  } = options;

  const targets = watchTargets(addresses, lookahead);
  const subscribed: string[] = [];
  const failed: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const fire = () => {
    if (disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed) onChange();
    }, debounceMs);
  };

  const startedAt = Date.now();

  await Promise.all(
    targets.map(async (address) => {
      try {
        await client.subscribe(address, () => {
          // Notifications before the settle window are the subscription's own
          // echo, not news.
          if (Date.now() - startedAt < settleMs) return;
          fire();
        });
        subscribed.push(address);
      } catch {
        failed.push(address);
      }
    }),
  );

  return {
    subscribed,
    failed,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      // Best effort: the client may already be closing with the wallet locked.
      await Promise.all(
        subscribed.map((address) =>
          client.unsubscribe(address).catch(() => undefined),
        ),
      );
    },
  };
}
