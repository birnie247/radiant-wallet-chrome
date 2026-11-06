/**
 * Step-up authentication for actions that move money.
 *
 * An unlocked session is remembered across popup opens (see src/lib/session.ts),
 * so being unlocked must not, on its own, authorise a payment. Every spend is
 * re-authorised here first by re-deriving the vault with the passphrase.
 *
 * The Android build accepted a biometric here as an equally valid proof. There is
 * no browser equivalent that actually unwraps a locally held key, so this build
 * offers the passphrase only — a real downgrade in convenience, stated plainly
 * instead of shipping something that looks hardware-backed and is not.
 *
 * The extra check survives from the original: the secret that comes back must
 * belong to the wallet currently open. A vault can be replaced underneath a
 * running session, and signing with the wrong seed would broadcast a transaction
 * from an account the user did not mean to spend. Better to refuse and ask again.
 */
import { unlockVault, type WalletSecrets } from "./vault";

/** Which proof the user supplied. */
export type ConfirmMethod = "passphrase";

/** Collapse spacing/case so a phrase re-typed or re-wrapped still matches. */
function normaliseMnemonic(mnemonic: string | undefined): string {
  return (mnemonic ?? "").trim().toLowerCase().split(/\s+/).join(" ");
}

/** Throw unless the confirmed secret is the wallet that is currently open. */
function assertSameWallet(
  confirmed: WalletSecrets,
  session: WalletSecrets,
): void {
  if (
    normaliseMnemonic(confirmed.mnemonic) !== normaliseMnemonic(session.mnemonic)
  ) {
    throw new Error(
      "That unlocks a different wallet — lock and unlock before sending",
    );
  }
}

/** Re-derive the vault with the passphrase and check it is this wallet. */
export async function confirmWithPassphrase(
  passphrase: string,
  session: WalletSecrets,
): Promise<void> {
  if (!passphrase) {
    throw new Error("Enter your passphrase to authorise this payment");
  }
  const confirmed = await unlockVault(passphrase);
  assertSameWallet(confirmed, session);
}
