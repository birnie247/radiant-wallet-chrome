#!/usr/bin/env node
/**
 * Load the built extension in a real Chrome and prove it works as an extension.
 *
 * check-csp.mjs serves the popup over http, which proves the bundle runs under an
 * MV3 policy — but not that Chrome accepts the manifest, that the service worker
 * registers, or that `chrome.storage` (the whole point of the storage refactor)
 * actually persists a wallet. Those only exist inside an extension context.
 *
 * The decisive assertion is the last one: create a wallet through the UI, reload
 * the popup, and require the Unlock screen. That fails if hydrate() did not run
 * before render, or if the vault did not survive in chrome.storage.local — either
 * of which would show a returning user the onboarding screen over their existing
 * wallet.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";

import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import WebSocket from "ws";

const DIST = resolve("dist");
const DEBUG_PORT = 9341;
const PASSPHRASE = "extension test passphrase";

const CHROME_CANDIDATES = [
  // CI sets this; the Windows paths below are for local runs.
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("✗ no Chrome binary found");
  process.exit(1);
}
if (!existsSync(join(DIST, "manifest.json"))) {
  console.error("✗ dist/manifest.json missing — run `npm run build` first");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "rxd-ext-load-"));
const proc = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    // Required for the Extensions domain below; without it loadUnpacked is refused.
    "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
const problems = [];

/** Minimal CDP session over one target. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      problems.push(`exception: ${d.exception?.description ?? d.text}`);
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      const e = msg.params.entry;
      if (!/favicon\.ico/.test(e.text + (e.url ?? ""))) {
        problems.push(`log: ${e.text}`);
      }
    }
  });
  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => pending.set(id, res));
  };
  await send("Runtime.enable");
  await send("Log.enable");
  return { ws, send };
}

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  return res.json();
}

/**
 * Install the built extension through CDP.
 *
 * Chrome 137+ removed the `--load-extension` command-line switch, so the old
 * automation trick silently loads nothing and every chrome-extension:// URL comes
 * back blocked. The supported route is the `Extensions` domain on the browser
 * target, which also tells us the extension id Chrome actually assigned — no
 * guessing from a path hash or a manifest key.
 */
async function loadUnpacked() {
  const version = await (
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
  ).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  const reply = await new Promise((resolve) => {
    ws.on("message", (raw) => resolve(JSON.parse(raw.toString())));
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Extensions.loadUnpacked",
        params: { path: DIST },
      }),
    );
  });
  ws.close();
  if (reply.error) {
    throw new Error(`loadUnpacked failed: ${reply.error.message}`);
  }
  return reply.result.id;
}


const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
}

// Try each candidate id until one actually serves the popup. A wrong id gives a
// tab Chrome refuses to load, so this verifies itself rather than trusting a hash.
// Chrome needs a moment before its debug endpoint answers — wait for it explicitly,
// because the very first fetch is otherwise a race that fails with ECONNREFUSED.
for (let i = 0; i < 80; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    if (res.ok) break;
  } catch {
    /* not listening yet */
  }
  await sleep(250);
}

let session = null;
const id = await loadUnpacked();
console.log(`extension installed by Chrome as ${id}`);
{
  const url = `chrome-extension://${id}/popup.html`;
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${url}`, {
    method: "PUT",
  });
  const opened = await res.json();
  await sleep(1000);
  const live = (await listTargets()).find((t) => t.id === opened.id);
  if (live?.webSocketDebuggerUrl) {
    session = await connect(live.webSocketDebuggerUrl);
  }
}

check("popup served from the extension's own origin", session !== null, id);
if (!session) {
  proc.kill();
  process.exit(1);
}

function evaluate(expression) {
  return session
    .send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    .then((res) => {
      const details = res.result?.exceptionDetails;
      if (details) {
        throw new Error(details.exception?.description ?? details.text);
      }
      return res.result?.result?.value;
    });
}

check(
  "popup served from the extension origin",
  String(await evaluate(`location.origin`)).startsWith("chrome-extension://"),
);

// chrome.storage is the reason this script exists: it only exists here.
const storageOk = await evaluate(`(async () => {
  if (!chrome?.storage?.local) return 'missing chrome.storage.local';
  await chrome.storage.local.set({ '__probe': 'ok' });
  const got = await chrome.storage.local.get('__probe');
  await chrome.storage.local.remove('__probe');
  return got.__probe === 'ok' ? 'ok' : 'round-trip failed';
})()`);
check("chrome.storage.local round-trips", storageOk === "ok", String(storageOk));

check(
  "app mounted in the extension",
  (await evaluate(`!!document.querySelector('#root .app')`)) === true,
);

// Drive the whole onboarding flow. React tracks input values, so the native
// setter has to be used for the change event to register.
const created = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = (t) => Array.from(document.querySelectorAll('button'))
    .find((b) => (b.textContent || '').trim().toLowerCase().includes(t));
  const type = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  (btn('create a new wallet') || { click() {} }).click();
  for (let i = 0; i < 60 && !document.querySelector('.seed-word'); i++) await sleep(100);
  if (!document.querySelector('.seed-word')) return 'seed never appeared';

  document.querySelector('input[type=checkbox]').click();
  await sleep(100);
  btn('continue').click();
  await sleep(300);

  const pw = () => Array.from(document.querySelectorAll('input[type=password]'));
  if (pw().length < 2) return 'passphrase fields missing: ' + pw().length;
  // Re-query between keystrokes: React re-renders after the first change and
  // replaces the second input node, so holding a reference types into a detached
  // element and the two passphrases silently never match.
  type(pw()[0], ${JSON.stringify(PASSPHRASE)});
  await sleep(200);
  type(pw()[1], ${JSON.stringify(PASSPHRASE)});
  await sleep(200);
  btn('create wallet').click();

  // PBKDF2 at 600k takes a moment. Poll storage rather than the UI: the next step
  // connects to Electrum, and this test must not depend on the network.
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    const stored = await chrome.storage.local.get('rxd.wallet.vault.v1');
    if (stored['rxd.wallet.vault.v1']) return 'saved';
  }
  return 'vault never persisted';
})()`);
check("wallet created and persisted to chrome.storage", created === "saved", String(created));

// The payoff: reload and require the Unlock screen, not onboarding.
await session.send("Page.enable");
await session.send("Page.reload", { ignoreCache: true });
await sleep(1500);
const afterReload = await evaluate(`({
  heading: (document.querySelector('h1') || {}).textContent || '',
  body: document.body.innerText.slice(0, 200),
  mounted: !!document.querySelector('#root .app'),
})`);
// Landing on either Unlock ("Welcome back") or the connecting splash both prove
// the wallet persisted — the splash actually proves more, because it means the
// remembered session in chrome.storage.session was restored too. What must never
// happen is onboarding over an existing wallet.
const body = afterReload?.body ?? "";
const recovered =
  /welcome back/i.test(`${afterReload?.heading ?? ""} ${body}`) ||
  /connect|scanning/i.test(body);
check(
  "wallet survives a popup reload (no onboarding screen)",
  afterReload?.mounted === true && recovered && !/create a new wallet/i.test(body),
  `heading="${afterReload?.heading}" body="${body.slice(0, 60).replace(/\n/g, " ")}"`,
);
check("no uncaught exceptions", problems.length === 0, problems.join(" | ").slice(0, 400));

session.ws.close();
proc.kill();
try {
  await sleep(400);
  rmSync(profile, { recursive: true, force: true });
} catch {
  /* temp dir */
}

const failed = checks.filter((c) => !c.ok).length;
console.log(failed === 0 ? "\nEXTENSION CHECK PASSED" : `\n${failed} EXTENSION CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

