# Lumen RXD Wallet extension 1.4.0

Synced with the Android wallet's 1.4.0 release. The wallet, signing and
transaction code is the same TypeScript as `birnie247/radiant-wallet-android`;
what differs is only what a browser extension has no equivalent for (no
Keystore-backed biometric, no screenshot blocking, popup-scoped sockets).

## What's new since 1.1.0

- **Glyph tokens — view and send.** A new Tokens screen lists every Glyph
  NFT/FT the wallet owns, grouped by artifact id (ref) — never by name or
  ticker, which collide freely. Token detail shows metadata, properties and
  the locked RXD riding inside each output. Whole-NFT and whole/partial-FT
  sends go through the SDK's ref-safe transfer path: the token output is never
  spent as a fee, so sending cannot burn the token, and sub-dust FT sends are
  refused loudly. Every transfer re-authenticates with your passphrase,
  exactly like an RXD payment.
- **Live token updates.** The foreground and the background watcher both
  subscribe to the zeroed-ref token scripthashes, so an incoming token lights
  the toolbar badge while the popup is closed. Home reports RXD locked in
  tokens separately from the spendable balance.
- **Coin-type detection on restore.** The same recovery phrase under
  m/44'/512' and m/44'/0' derives two disjoint address sets. Restore now asks
  the chain which set the phrase actually uses, so an older wallet no longer
  restores into an empty balance that looks like lost funds. Settings →
  Derivation can switch address sets later (passphrase-confirmed; nothing is
  signed, moved or broadcast).
- **Latest-transaction view.** Recent activity collapses to the newest
  transaction with a one-tap expander for the last 25, and funds-by-address
  rows copy the full address on tap.

## Install

1. Download and extract the zip below.
2. Open `chrome://extensions` and enable **Developer mode**.
3. **Load unpacked** → select the extracted folder.

Requires Chrome 116+ (offscreen documents). There is no store listing, so
Chrome will note that the extension is not from the Web Store — expected for
sideloaded code you can read. An existing 1.1.0 install keeps its wallet:
same storage keys, same vault format.

## Before you trust it

Unaudited software handling real money. Balances and confirmations are checked
with SPV against a pinned checkpoint, but the difficulty-adjustment rule is not
validated, so the guarantee is "an attacker needs real work" rather than "an
attacker cannot". Token sends are proven on mainnet by the Android build's live
harness and this extension shares that code, but this build has not yet made
its own funded send — start small. The
[README](https://github.com/birnie247/radiant-wallet-chrome#readme) states
exactly what is and is not verified.