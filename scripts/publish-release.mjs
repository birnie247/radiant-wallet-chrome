#!/usr/bin/env node
/**
 * Publish the built extension as a GitHub release.
 *
 *   npm run build
 *   npm run publish:release      # needs GITHUB_TOKEN with `repo` scope
 *
 * The asset is a zip of `dist/`, because that is what a user can actually install:
 * extract it, open `chrome://extensions`, enable Developer mode, "Load unpacked".
 * Chrome will not install a plain `.crx` from outside the Web Store without extra
 * steps, and an unpacked build from source is the honest way to run this anyway.
 *
 * Notes are generated from the bytes being uploaded — size and SHA-256 computed, not
 * typed — so the published hashes cannot drift from the artifact.
 */
import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { zipDirectory } from "./lib/zip.mjs";

const API = "https://api.github.com";
const OUT_DIR = "dist-release";

const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token) die("GITHUB_TOKEN is not set (needs `repo` scope)");

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const tag = `v${version}`;
if (!existsSync(join("dist", "manifest.json"))) {
  die("dist/manifest.json missing — run `npm run build` first");
}

// The shipped manifest version must match the tag, or Chrome reports a different
// number than the release users downloaded.
const manifestVersion = JSON.parse(
  readFileSync(join("dist", "manifest.json"), "utf8"),
).version;
if (manifestVersion !== version) {
  die(`dist manifest says ${manifestVersion} but package.json says ${version} — rebuild`);
}

const repoSlug = (() => {
  const remote = execFileSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf8",
  }).trim();
  const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) die(`cannot parse a GitHub repo from origin: ${remote}`);
  return `${m[1]}/${m[2]}`;
})();

mkdirSync(OUT_DIR, { recursive: true });
const assetName = `lumen-rxd-wallet-extension-${version}.zip`;
const assetPath = join(OUT_DIR, assetName);
const entries = zipDirectory("dist", assetPath);
const bytes = readFileSync(assetPath);
const size = statSync(assetPath).size;
const sha256 = createHash("sha256").update(bytes).digest("hex");

console.log(`repo   ${repoSlug}`);
console.log(`tag    ${tag}`);
console.log(`asset  ${assetName}  ${size} bytes  (${entries.length} files)`);
console.log(`sha256 ${sha256}`);

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "rxd-wallet-release",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { res, text, json: text ? JSON.parse(text) : null };
}


function buildBody() {
  const notesFile = join("docs", `release-notes-${version}.md`);
  if (existsSync(notesFile)) {
    console.log(`notes  ${notesFile}`);
    return readFileSync(notesFile, "utf8");
  }
  return [
    "Manifest V3 Chrome extension, built from this commit.",
    "",
    "## Install",
    "",
    "1. Download and extract the zip below.",
    "2. Open `chrome://extensions` and enable **Developer mode**.",
    "3. **Load unpacked** → select the extracted folder.",
    "",
    "Requires Chrome 116+ (offscreen documents). There is no store listing, so Chrome",
    "will note that the extension is not from the Web Store — expected for sideloaded",
    "code you can read.",
    "",
    "## Verify",
    "",
    "| | |",
    "| --- | --- |",
    `| File | \`${assetName}\` |`,
    `| Size | ${size.toLocaleString("en-US")} bytes |`,
    `| SHA-256 | \`${sha256}\` |`,
    `| Files | ${entries.length} |`,
    "",
    "```bash",
    `sha256sum ${assetName}`,
    "```",
    "",
    "## Before you trust it",
    "",
    "Unaudited software handling real money. Balances and confirmations are checked",
    "with SPV against a pinned checkpoint, but the difficulty-adjustment rule is not",
    "validated, so the guarantee is \"an attacker needs real work\" rather than \"an",
    "attacker cannot\". Sending has never been exercised with real funds from this",
    "build — the Android app is the one with a mainnet send behind it. The",
    `[README](https://github.com/${repoSlug}#readme) states exactly what is and is not`,
    "verified.",
  ].join("\n");
}

let release;
{
  const existing = await api(`/repos/${repoSlug}/releases/tags/${tag}`);
  if (existing.res.ok) {
    release = existing.json;
    console.log(`release exists (id ${release.id}) — reusing`);
  } else if (existing.res.status === 404) {
    const created = await api(`/repos/${repoSlug}/releases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: "main",
        name: `Lumen RXD Wallet extension ${version}`,
        body: buildBody(),
        draft: false,
        prerelease: false,
      }),
    });
    if (!created.res.ok) {
      die(`create failed ${created.res.status}: ${created.text.slice(0, 400)}`);
    }
    release = created.json;
    console.log(`release created (id ${release.id})`);
  } else {
    die(`lookup failed ${existing.res.status}: ${existing.text.slice(0, 400)}`);
  }
}

const already = (release.assets ?? []).find((a) => a.name === assetName);
if (already && already.size === size) {
  console.log(`asset already attached (${already.size} bytes) — nothing to do`);
} else {
  const up = await fetch(
    `https://uploads.github.com/repos/${repoSlug}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "rxd-wallet-release",
        "Content-Type": "application/zip",
        "Content-Length": String(bytes.length),
      },
      body: bytes,
    },
  );
  const text = await up.text();
  if (!up.ok) die(`upload failed ${up.status}: ${text.slice(0, 400)}`);
  const asset = JSON.parse(text);
  if (asset.size !== size) die(`uploaded size ${asset.size} != local ${size}`);
  console.log(`asset uploaded (id ${asset.id}, ${asset.size} bytes)`);
}

console.log(`\n✓ ${release.html_url}`);
console.log(`  download: https://github.com/${repoSlug}/releases/download/${tag}/${assetName}`);
