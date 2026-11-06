# Radiant Wallet — Chrome extension

A self-custody wallet for [Radiant](https://radiantblockchain.org) (RXD) as a
Manifest V3 Chrome extension. The recovery phrase is generated, encrypted and used
to sign entirely inside the extension; no server ever sees a private key.

This is a port of the Android build in `../rxd-wallet` — the wallet, signing and
transaction code is the same, battle-tested TypeScript. What differs is everything
that touched a native layer, because a browser extension has no Keystore, no
`FLAG_SECURE` and no popup that survives a click outside.

| | |
| --- | --- |
| Manifest | V3, `minimum_chrome_version: 116` |
| Permissions | `storage` only — no host permissions, no content scripts |
| Popup size | 400 × 600 |
| Licence | MIT, with Apache-2.0 artwork |

**Contents:** [Install](#install) · [What changed from the Android app](#what-changed-from-the-android-app) ·
[Security model](#security-model) · [MV3 constraints that shaped this](#mv3-constraints-that-shaped-this) ·
[Architecture](#architecture) · [Testing](#testing) · [Known limitations](#known-limitations) · [Licence](#licence)

---

## Install

```bash
npm install
npm run build      # → dist/
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked**
→ select the `dist` folder.

There is no packaged `.crx`: Chrome no longer installs one that isn't from the Web
Store without extra steps, and an unpacked build is the honest way to run code you
compiled yourself.

For UI work there is also a plain dev server (`npm run dev`), but a browser tab is
not an extension: `chrome.storage` is absent, so the wallet persists nothing and
forgets everything on reload.

## What changed from the Android app

| Android | Here | Why |
| --- | --- | --- |
| Biometric unlock + biometric send confirmation | **Removed** — passphrase only | No Keystore-backed key exists in a browser. The WebAuthn/passkey path cannot unwrap a locally stored key without an authenticator that supports `hmac-secret`; imitating hardware-backed auth would be worse than not offering it |
| Auto-lock when backgrounded | **Stay unlocked** timeout (0 s / 1 / 5 / 15 / 60 min, default 5 min) | A popup is destroyed rather than backgrounded, so there is nothing to detect. The unlock is kept in `chrome.storage.session` and expires on a timestamp |
| `FLAG_SECURE` blocks screenshots | **Not possible** | Extensions cannot block screen capture. The seed sheet therefore re-asks for the passphrase and says so plainly |
| `localStorage` | `chrome.storage.local` | `localStorage` does not exist in an MV3 service worker, and extension state belongs in extension storage. See [storage.ts](src/lib/storage.ts) |
| Native `OpenUrl` plugin | `chrome.tabs.create`, still host-allowlisted | No WebView to escape; the allowlist stays so the wallet is not a URL launcher |
| Electrum socket dies with the app | Socket lives only while the popup is open | See [Known limitations](#known-limitations) |

Sending still requires the passphrase **every time**, and the secret that comes back
must belong to the wallet on screen — that check survives from the Android build
(`src/lib/reauth.ts`).

## Security model

**What protects the seed**

- **At rest:** AES-256-GCM under PBKDF2-SHA256 (600,000 iterations), 12-character
  minimum passphrase, in `chrome.storage.local`. Only ciphertext is stored.
- **This extension is unreachable from the web.** No content scripts, no
  `web_accessible_resources`, no `externally_connectable`, no host permissions.
  Nothing a page can do reaches the wallet — in exchange there is no dApp provider,
  which was a deliberate choice rather than an oversight.
- **Unlock lifetime is bounded and configurable.** The unlocked secret lives in
  `chrome.storage.session`, which Chrome documents as memory-only: never written to
  disk, cleared when the browser closes. Setting *Immediately* stores nothing at
  all, so every popup open costs a passphrase.
- **Every payment re-authenticates**, even inside an unlocked session.

**What is weaker than the Android build, stated plainly:** no hardware-backed key, no
biometric, no screen-capture blocking, and the unlocked secret sits in
browser-managed memory rather than a TEE. The passphrase is the only door, which is
why its minimum length and KDF cost were not relaxed for browser convenience.

## MV3 constraints that shaped this

Three that cost real time, recorded so they aren't rediscovered:

1. **The Radiant SDK bundles msgpackr, which generates codec functions with
   `new Function`.** MV3 forbids that. msgpackr detects the failure and degrades,
   but "it degrades" is an assumption — `npm run check:csp` serves the build under
   an MV3 policy and creates a wallet through the UI to prove the crypto path works
   with **zero** CSP violations.
2. **Vite injects an inline modulepreload polyfill**, which `script-src 'self'`
   blocks. Hence `build.modulePreload.polyfill = false`, and the startup watchdog is
   an external module (`src/boot-guard.ts`) in its own graph so it can still report
   a bundle that fails to evaluate.
3. **Chrome 137+ removed the `--load-extension` switch.** Automated unpacked loading
   now goes through the CDP `Extensions.loadUnpacked` command with
   `--enable-unsafe-extension-debugging`. The old flag silently loads nothing and
   every `chrome-extension://` URL comes back blocked.
4. **An offscreen document does not get `chrome.storage`.** It sits outside the
   offscreen API subset, so the background watcher cannot read the watch list itself:
   the service worker pushes configuration to it by message and answers a
   `watch:hello` on startup. A runtime `Cannot read properties of undefined (reading
   'onChanged')` is how that surfaced — and why the extension check asserts the
   watcher's socket state rather than merely that a document exists.

## SPV: proving transactions instead of trusting the server

`src/lib/spv.ts` removes "believe the Electrum server" from the wallet:

1. **Header proof of work** — every block hash must meet the target its own `bits`
   encodes.
2. **Chain linkage from a pinned checkpoint** — `CHECKPOINT` names one block (hash
   and height) this build trusts; the server's header at that height is re-hashed
   and compared before anything else is believed, then every header up to the tip
   must name its predecessor.
3. **Merkle inclusion** — each confirmed transaction's branch is folded and
   compared with that block's merkle root.
4. **Transaction binding** — the transaction id must equal the hash of the body the
   server returned, so a substituted transaction cannot ride an older proof.

Three constants were measured against mainnet rather than assumed, and each would
have produced a verifier that silently never fails if guessed:

| Fact | Reality |
| --- | --- |
| Block hash / proof of work | double **SHA-512/256** — double SHA-256 does *not* satisfy the target |
| Transaction id | double **SHA-256** |
| Merkle tree | double **SHA-256**, a different hash from proof of work |

Results are visible in the UI: proven rows carry a **✓ proven** badge, and Home
states how far the chain was verified, or why it was not.

**What this does not do.** Radiant retargets difficulty on *every* block (398 of 400
consecutive mainnet headers carry a different `bits`), so checking the adjustment
rule needs the consensus formula, which this build does not implement. Instead each
header's target must stay within `MAX_TARGET_FACTOR` (2×) of the checkpoint's. That
bounds the damage — forging blocks from the checkpoint still costs at least half the
real work over that span, which at Radiant's difficulty nobody can do — but it is a
bound, not a proof. The trade-off runs the other way too: a genuine hash-rate
collapse could make the wallet refuse to sync until a new checkpoint ships. That is
a loud, recoverable failure rather than a silent one, and it is why the checkpoint
sits near the tip.

Updating the checkpoint is a one-line change in `spv.ts`; the test suite prints the
live tip so picking a new one is a copy-and-paste.

## Background updates (offscreen document)

An MV3 service worker is terminated when idle and cannot hold a WebSocket, so the
extension uses an **offscreen document** to keep one open while the popup is closed.
When a watched address moves, that document tells the service worker, which lights
the toolbar badge; opening the popup clears it and rescans.

The design constraint that matters is that **the background never holds a key**. The
popup hands over only what is already public — an endpoint and the scripthashes of
the addresses worth watching (`src/lib/watchList.ts`) — so the watcher can keep
running while the wallet is locked without weakening the passphrase at all. The
offscreen document contains no SDK, no signing code and no secrets; it speaks raw
JSON-RPC for `blockchain.scripthash.subscribe` plus a keepalive ping, with backoff
reconnection.

Two consequences worth knowing:

- It is a **change signal, not a live balance**. The background cannot derive
  addresses or compute a balance, so the numbers still come from the popup's scan.
- It is **a privacy choice, not a security one**. Settings → *Stop background
  updates* closes the socket; while it is on, your server sees you watching those
  addresses even when the wallet is locked. Deleting the wallet also clears the list
  and stops the watcher.


## Architecture

```
popup.html              two external module scripts: boot-guard, then the app
offscreen.html          no UI; exists only to hold a WebSocket
src/
  main.tsx              hydrates storage, then mounts React
  boot-guard.ts         renders real errors instead of a blank popup
  background.ts         service worker: defaults, watcher lifecycle, badge
  offscreen.ts          background Electrum subscription (no keys, no SDK)
  lib/
    storage.ts          write-through mirror over chrome.storage.local
    session.ts          unlocked-session lifetime in chrome.storage.session
    vault.ts            encrypted seed (versioned KDF policy)
    wallet.ts           connect, BIP44 scan, UTXO fetch, build/broadcast
    history.ts          net effect and confirmation counts
    liveUpdates.ts      scripthash push subscriptions
    servers.ts          endpoint list and connect budgets
    price.ts            RXD/USD, cached, opt-out
    openTab.ts          allowlisted explorer links via chrome.tabs
    reauth.ts           per-payment passphrase confirmation
    spv.ts              header PoW, chain linkage, merkle inclusion
    watchList.ts        public watch list handed to the background
  screens/              Onboarding, Unlock, Home, Receive, Send, Settings
public/
  manifest.json         MV3 manifest
  icons/                generated by `npm run icons`
scripts/
  browser-path-check.ts crypto, signing, history, session, price, live updates
  check-csp.mjs         the real bundle under an MV3 CSP in headless Chrome
  check-extension.mjs   installs the extension in Chrome and drives onboarding
```

The service worker deliberately imports nothing: a shared chunk it had to fetch
would be one more way for the extension to fail at startup.

## Testing

```bash
npm run typecheck
npm run check:browser     # crypto, signing, history, session, price, updates, SPV
npm run check:csp         # the built bundle under an MV3 CSP, wallet creation included
npm run check:extension   # installs in Chrome, creates a wallet, reloads the popup
npm run check             # all of the above, in order
```

`check:extension` matters most: it proves Chrome *accepts* the manifest, that
`chrome.storage.local` genuinely persists the vault, and that a reload lands on
Unlock rather than offering to create a second wallet over the first. `check:csp`
proves the SDK runs without `unsafe-eval`. `check:browser` covers the money paths —
BIP39 derivation against a known vector, a signed transaction (sighash `0x41`,
correct pubkey), the ref-burn guard, and connection-budget behaviour.

Each of these caught a real bug while being written: a missing-value/`0` collision
in the unlock-timeout parser, `localStorage` call sites that had never been moved to
`chrome.storage` (so nothing persisted in the extension), and a vacuous layout
assertion that compared the viewport to itself.

## Known limitations

1. **Background updates are a change signal, not a live balance.** An offscreen
   document keeps the subscription open and lights the toolbar badge when your
   addresses move, but the re-scan still happens when the popup opens: the
   background deliberately holds no keys, so it cannot derive or sign anything.
2. **Broadcast is proven only by one real send.** The first funded transaction was
   sent from the Android build by the project owner and broadcast successfully;
   everything up to a valid signature is verified in the test suite here too. That is
   real evidence, but one send is not a track record — start small.
3. **SPV is bounded, not complete.** Headers, chain linkage and merkle proofs are
   verified (see [SPV](#spv-proving-transactions-instead-of-trusting-the-server)),
   but the difficulty-adjustment rule is not, so the guarantee is "an attacker needs
   real work" rather than "an attacker cannot". Blocks older than the pinned
   checkpoint are unverified.
4. **No dApp provider.** Nothing is injected into pages; this is a wallet you open,
   not one websites can talk to.
5. **`chrome.storage.local` is not encrypted by the browser.** It is protected by the
   OS profile and the passphrase, not by Chrome.
6. **Screenshots cannot be blocked**, so the recovery-phrase sheet warns instead.
7. **QR scanning, Glyph tokens and WAVE names** are not implemented, as in the
   Android build.

## Licence

**MIT** — see [LICENSE](LICENSE). `src/assets/radiant-mark*.png` and the icons
generated from them are **Apache-2.0**, from the Radiant project; keep their
attribution.

Signing, ref-safety and Glyph logic come from
[`@radiant-core/sdk`](https://github.com/Radiant-Core/radiant-sdk) and
`@radiant-core/radiantjs` (MIT). The endpoint list is adapted from
[Photonic Wallet](https://github.com/RadiantBlockchain-Community/photonic-wallet).
This is an independent client, not affiliated with the Radiant Foundation.

Use at your own risk — this is unaudited software handling real money.


