/**
 * Encrypted seed storage.
 *
 * The mnemonic is encrypted with AES-256-GCM using a key stretched from the
 * user's passphrase with PBKDF2-SHA256. Only the ciphertext is persisted, and
 * the plaintext exists in memory solely while the wallet is unlocked.
 *
 * Policy (security report MEDIUM-1 / L4):
 *   • 600,000 PBKDF2-SHA256 iterations — OWASP's current PBKDF2-HMAC-SHA256
 *     floor (was 310k, roughly half that).
 *   • 12-character minimum passphrase for new wallets, plus a trivially-weak
 *     check. Short passphrases are the weakest link once a blob is exfiltrated:
 *     the KDF cannot rescue a 6-character secret.
 *   • The KDF parameters are stored with the vault and *validated on read*
 *     (bounded range) rather than trusted blindly, and vaults written under the
 *     old policy are transparently re-encrypted at the current cost on the next
 *     successful unlock — the user keeps their passphrase.
 *
 * Threat model note: this protects a lost/stolen device backup and casual
 * filesystem inspection. It does NOT protect against a rooted device with a
 * memory dumper. See README "Security model".
 */
import type { NetworkName } from "@radiant-core/sdk";
import { getItem, removeItem, setItem } from "./storage";

const STORAGE_KEY = "rxd.wallet.vault.v1";

/** Current KDF cost. Bump VAULT_SCHEMA when the parameters change. */
const KDF_ITERATIONS = 600_000;
const KDF_ALGORITHM = "PBKDF2-SHA256";
const VAULT_SCHEMA = 2;

/** Refuse absurd stored parameters (tampering / denial of service). */
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 5_000_000;

export const MIN_PASSPHRASE_LENGTH = 12;

/** SLIP-44 coin type of every wallet this extension creates (Radiant). */
export const RADIANT_COIN_TYPE = 512;

/**
 * Coin type used by seeds made *before* 512 became the default.
 *
 * The SDK's `HDWalletOptions.coinType` documents exactly this: "Pass 0 only to
 * recover legacy wallets created before the coin-type-512 default." The same
 * phrase under a different coin type derives a completely different address set,
 * so this is the only thing that makes an old seed find its funds. Android calls
 * these "v1 seeds"; the checkbox in onboarding writes this value.
 */
export const LEGACY_COIN_TYPE = 0;

export interface WalletSecrets {
  mnemonic: string;
  network: NetworkName;
  /** Preferred ElectrumX endpoint; empty means use the built-in pool. */
  server: string;
  label: string;
  createdAt: number;
  /**
   * Coin type this wallet derives with. Absent means {@link RADIANT_COIN_TYPE};
   * {@link LEGACY_COIN_TYPE} marks a wallet restored from a "v1" seed. Stored
   * rather than inferred, because derivation must be identical on every unlock or
   * the wallet looks empty.
   */
  coinType?: number;
}

export interface StoredVault {
  /** 1 = original (310k, 6-char floor); 2 = current policy. */
  v: number;
  kdf: typeof KDF_ALGORITHM;
  iterations: number;
  salt: string;
  iv: string;
  ct: string;
  createdAt: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Uint8Array is not structurally assignable to BufferSource in every TS lib
// version, so normalise at the WebCrypto boundary.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(value: string): Uint8Array {
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    bs(encoder.encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: bs(salt), iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Passphrase policy for NEW wallets.
 * Returns a user-facing error, or null when acceptable.
 */
export function checkPassphrase(passphrase: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `Use at least ${MIN_PASSPHRASE_LENGTH} characters — the passphrase is the only thing protecting your recovery phrase.`;
  }
  if (new Set(passphrase).size < 4) {
    return "That passphrase is too repetitive — use something less predictable.";
  }
  const lower = passphrase.toLowerCase();
  const blocked = ["password", "123456789012", "qwertyuiopas", "letmein123456"];
  if (blocked.some((b) => lower.includes(b))) {
    return "That passphrase is too common. Pick something unique.";
  }
  return null;
}

export function hasVault(): boolean {
  return getItem(STORAGE_KEY) !== null;
}

function readStored(): StoredVault | null {
  const raw = getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredVault;
    if (!parsed?.ct || !parsed?.salt || !parsed?.iv) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readVaultMeta(): {
  createdAt: number;
  iterations: number;
  schema: number;
} | null {
  const stored = readStored();
  if (!stored) return null;
  return {
    createdAt: stored.createdAt,
    iterations: stored.iterations,
    schema: stored.v ?? 1,
  };
}

/** True when the stored vault predates the current KDF policy. */
export function needsKdfUpgrade(): boolean {
  const stored = readStored();
  return !!stored && (stored.v ?? 1) < VAULT_SCHEMA;
}

/**
 * Encrypt + persist. No policy check: this is also the re-encryption path for
 * vaults created under an older (weaker) policy, whose passphrase must keep
 * working even if it would not satisfy today's minimum length.
 */
async function writeVault(
  passphrase: string,
  secrets: WalletSecrets,
  iterations: number,
): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bs(iv) },
    key,
    bs(encoder.encode(JSON.stringify(secrets))),
  );

  const stored: StoredVault = {
    v: VAULT_SCHEMA,
    kdf: KDF_ALGORITHM,
    iterations,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(new Uint8Array(ct)),
    createdAt: Date.now(),
  };
  setItem(STORAGE_KEY, JSON.stringify(stored));
}

/** Create a NEW vault, enforcing the current passphrase policy. */
export async function saveVault(
  passphrase: string,
  secrets: WalletSecrets,
): Promise<void> {
  const problem = checkPassphrase(passphrase);
  if (problem) throw new Error(problem);
  await writeVault(passphrase, secrets, KDF_ITERATIONS);
}

export async function unlockVault(passphrase: string): Promise<WalletSecrets> {
  const stored = readStored();
  if (!stored) throw new Error("No wallet on this device");

  // Never trust stored KDF parameters blindly: reject out-of-range values
  // rather than letting a tampered blob force an absurd or trivial work factor.
  const iterations = Number(stored.iterations);
  if (
    !Number.isFinite(iterations) ||
    iterations < MIN_ITERATIONS ||
    iterations > MAX_ITERATIONS
  ) {
    throw new Error("Wallet data is corrupted (invalid KDF parameters)");
  }

  const key = await deriveKey(passphrase, fromB64(stored.salt), iterations);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bs(fromB64(stored.iv)) },
      key,
      bs(fromB64(stored.ct)),
    );
  } catch {
    // GCM authentication failure = wrong passphrase (or tampered vault).
    throw new Error("Wrong passphrase");
  }

  const secrets = JSON.parse(decoder.decode(plain)) as WalletSecrets;
  if (!secrets?.mnemonic) throw new Error("Wallet data is corrupted");

  // Transparent KDF upgrade: same passphrase, current cost. Best effort — a
  // storage failure must not lock the user out of their own wallet.
  if ((stored.v ?? 1) < VAULT_SCHEMA) {
    try {
      await writeVault(passphrase, secrets, KDF_ITERATIONS);
    } catch {
      /* keep the old vault; it still opens */
    }
  }

  return secrets;
}

/** Update the stored settings without changing the passphrase. */
export async function updateVaultSettings(
  passphrase: string,
  patch: Partial<Pick<WalletSecrets, "server" | "label">>,
): Promise<WalletSecrets> {
  const current = await unlockVault(passphrase);
  const next = { ...current, ...patch };
  await writeVault(passphrase, next, KDF_ITERATIONS);
  return next;
}

export function deleteVault(): void {
  removeItem(STORAGE_KEY);
}

