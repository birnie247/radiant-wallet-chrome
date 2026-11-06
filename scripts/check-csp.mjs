#!/usr/bin/env node
/**
 * Prove the built popup runs under an MV3 extension CSP.
 *
 * Why this exists: MV3 serves extension pages with `script-src 'self'`, which
 * forbids `eval` and `new Function`. The Radiant SDK bundle embeds msgpackr, which
 * normally *generates a decoder function at runtime*. msgpackr feature-detects a
 * missing `new Function` and degrades, but "it degrades" is exactly the kind of
 * assumption that should be measured rather than reasoned about — a failure here
 * would be invisible until a real user opened the popup.
 *
 * So: serve dist/ with a CSP matching MV3, drive a real Chrome over the DevTools
 * protocol, create a wallet through the UI, and assert that
 *
 *   • the app mounted at all,
 *   • no CSP violation or uncaught exception was logged,
 *   • BIP39 generation produced 12 words (that path touches the CSPRNG, the
 *     HMAC-SHA512 shim and the wordlist — i.e. the crypto the SDK needs).
 *
 * Usage: node scripts/check-csp.mjs [--dist dist]
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import WebSocket from "ws";

const DIST = process.argv.includes("--dist")
  ? process.argv[process.argv.indexOf("--dist") + 1]
  : "dist";
const PORT = 4190;
const DEBUG_PORT = 9339;

/** Mirrors MV3's default extension-page policy (plus explicit style/img/font). */
const CSP =
  "script-src 'self'; object-src 'self'; img-src 'self' data:; " +
  "font-src 'self' data:; style-src 'self' 'unsafe-inline'";

const CHROME_CANDIDATES = [
  // CI sets this (Linux runners do not use the Windows paths below).
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("✗ no Chrome/Edge binary found");
  process.exit(1);
}
if (!existsSync(join(DIST, "popup.html"))) {
  console.error(`✗ ${DIST}/popup.html missing — run \`npm run build\` first`);
  process.exit(1);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const rel = url.pathname === "/" ? "/popup.html" : url.pathname;
  const file = join(DIST, rel.replace(/^\/+/, ""));
  if (!existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "Content-Security-Policy": CSP,
  });
  res.end(readFileSync(file));
});

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
console.log(`serving ${DIST}/ with MV3-style CSP on :${PORT}`);

const profile = mkdtempSync(join(tmpdir(), "rxd-ext-csp-"));
const proc = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    // Standard for CI containers: Chrome cannot use its sandbox there, and
    // /dev/shm is small. Both are no-ops on a normal desktop.
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--window-size=400,600",
    `http://127.0.0.1:${PORT}/popup.html`,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Find the page target, retrying: Chrome needs a moment to start listening. */
async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`);
      const targets = await res.json();
      const page = targets.find(
        (t) => t.type === "page" && t.url.includes(`:${PORT}`),
      );
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  throw new Error("no page target appeared");
}

const target = await pageTarget().catch((e) => {
  // A Chrome that died on startup is the usual cause, and the exit code is the
  // only clue the harness can offer.
  throw new Error(
    `${e.message} (chrome exit: ${proc.exitCode ?? "still running"}, binary: ${chrome})`,
  );
});
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});

let nextId = 1;
const pending = new Map();
const problems = [];

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  // Everything the page complains about that could be CSP-related.
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    problems.push(`exception: ${d.exception?.description ?? d.text}`);
  }
  if (msg.method === "Log.entryAdded") {
    const entry = msg.params.entry;
    if (entry.level === "error") {
      problems.push(`log: ${entry.text}${entry.url ? ` <- ${entry.url}` : ""}`);
    }
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    const text = msg.params.args
      .map((a) => a.value ?? a.description ?? "")
      .join(" ");
    problems.push(`console: ${text}`);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

/** Evaluate in the page and return the value. */
async function evaluate(expression) {
  const res = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const details = res.result?.exceptionDetails;
  if (details) {
    throw new Error(details.exception?.description ?? details.text);
  }
  return res.result?.result?.value;
}

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
// Reload now that listeners exist, so startup problems are actually captured.
await send("Page.reload", { ignoreCache: true });
await sleep(1200);


const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
}

// 1. Did the app mount? boot-guard.ts renders .boot-error when it did not.
const mounted = await evaluate(`!!document.querySelector('#root .app')`).catch(
  () => false,
);
const bootError = await evaluate(
  `(document.querySelector('.boot-error') || {}).textContent || ''`,
).catch(() => "");
check("popup mounted under MV3 CSP", mounted === true, String(bootError).slice(0, 300));

// 2. Create a wallet through the UI: CSPRNG + HMAC-SHA512 shim + wordlist.
const created = await evaluate(`(async () => {
  const byText = (t) => Array.from(document.querySelectorAll('button'))
    .find((b) => (b.textContent || '').trim().toLowerCase().includes(t));
  const create = byText('create a new wallet');
  if (!create) return { error: 'create button not found' };
  create.click();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const words = Array.from(document.querySelectorAll('.seed-word'));
    if (words.length > 0) {
      return {
        words: words.length,
        heading: (document.querySelector('h1') || {}).textContent || '',
      };
    }
  }
  return { error: 'seed never appeared: ' + document.body.innerText.slice(0, 200) };
})()`);

check(
  "BIP39 generation works under CSP",
  created?.words === 12,
  created?.error ?? `${created?.words} words`,
);
check(
  "seed screen rendered",
  /back up/i.test(created?.heading ?? ""),
  created?.heading ?? "",
);

// 3. Layout at popup size. The stylesheet came from a phone app, so the risk is a
//    fixed-width element forcing horizontal overflow inside a 400px popup.
//    Measuring the widest element is the actual test: documentElement.scrollWidth
//    just reports the viewport, which would make this assertion vacuous.
const layout = await evaluate(`(() => {
  let maxRight = 0;
  let widest = '';
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > maxRight) {
      maxRight = r.right;
      widest = el.className || el.tagName;
    }
  }
  return {
    maxRight: Math.round(maxRight),
    widest: String(widest).slice(0, 40),
    bodyWidth: document.body.getBoundingClientRect().width,
    bodyHeight: document.body.getBoundingClientRect().height,
  };
})()`);
check(
  "nothing overflows the 400px popup width",
  (layout?.maxRight ?? 9999) <= 401,
  `widest right edge ${layout?.maxRight}px (${layout?.widest})`,
);
check(
  "document is sized to the popup, not the viewport",
  Math.round(layout?.bodyWidth ?? 0) === 400 &&
    Math.round(layout?.bodyHeight ?? 0) === 600,
  `${layout?.bodyWidth}x${layout?.bodyHeight}`,
);

// 4. Nothing that looks like a CSP refusal. The browser's automatic
//    /favicon.ico request 404s against any static server; it is not an app fault.
const appProblems = problems.filter((p) => !/favicon\.ico/.test(p));
const ignored = problems.filter((p) => /favicon\.ico/.test(p));
if (ignored.length > 0) {
  console.log(`       (ignored ${ignored.length} browser favicon request)`);
}
const cspProblems = appProblems.filter((p) =>
  /content security policy|refused to evaluate|unsafe-eval|Refused to/i.test(p),
);
check("no CSP violations", cspProblems.length === 0, cspProblems.join(" | ").slice(0, 400));
check("no uncaught exceptions", appProblems.length === 0, appProblems.join(" | ").slice(0, 400));

ws.close();
proc.kill();
server.close();
// Chrome holds files in the profile briefly on Windows; a failure to clean up
// must not look like a test failure.
try {
  await sleep(400);
  rmSync(profile, { recursive: true, force: true });
} catch {
  /* temp dir; the OS will reap it */
}

const failed = checks.filter((c) => !c.ok).length;
console.log(failed === 0 ? "\nCSP CHECK PASSED" : `\n${failed} CSP CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

