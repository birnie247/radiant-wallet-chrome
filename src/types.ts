import type { ElectrumClient, HDWallet } from "@radiant-core/sdk";
import type { WalletSecrets } from "./lib/vault";
import type { ScanResult } from "./lib/wallet";
import type { HistoryEntry } from "./lib/history";
import type { PriceResult } from "./lib/price";

/** An unlocked, connected wallet. Lives only in memory. */
export interface Session {
  secrets: WalletSecrets;
  wallet: HDWallet;
  client: ElectrumClient;
  endpoint: string;
  scan: ScanResult;
}

export type Screen = "home" | "receive" | "send" | "settings";

/** Navigation + wallet handles handed to every screen. */
export interface Nav {
  session: Session;
  go: (screen: Screen) => void;
  refresh: () => Promise<void>;
  lock: () => void;
  /** Drop the current socket and connect again (used after a server change). */
  reconnect: () => Promise<void>;
  /** Non-empty while a long operation is running. */
  busy: string;
  /** Confirmation-annotated history, newest first. Null until loaded. */
  history: HistoryEntry[] | null;
  /** Total transactions known across all addresses (may exceed history.length). */
  historyTotal: number;
  /**
   * Difference between the primary server's tip and an independent operator's.
   * Null when no cross-check was possible. Non-zero means the servers disagree.
   */
  tipDrift: number | null;
  /**
   * How long the unlocked session survives a popup close, in milliseconds.
   * 0 means "lock immediately" — nothing is kept, so every popup open asks for
   * the passphrase.
   */
  unlockTimeoutMs: number;
  setUnlockTimeoutMs: (ms: number) => void;
  /**
   * Whether the extension keeps watching the chain while the popup is closed.
   * Only public data crosses into the background, so this is a privacy choice
   * rather than a security one.
   */
  watchEnabled: boolean;
  setWatchEnabled: (enabled: boolean) => void;
  /**
   * Result of SPV header verification, or null before the first attempt.
   * `ok: false` means the chain could not be verified and `reason` says why —
   * the wallet stays usable, but nothing should claim to be proven.
   */
  spv: {
    ok: boolean;
    tip: number;
    checked: number;
    reason: string;
  } | null;

  /** RXD/USD price, or null when unavailable or fiat display is off. */
  price: PriceResult | null;
  /** Whether fiat values are shown (opt-out; see price.ts). */
  fiatEnabled: boolean;
  setFiatEnabled: (enabled: boolean) => void;
}
