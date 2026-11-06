#!/usr/bin/env node
/**
 * Stamp the built manifest's version from package.json.
 *
 * Chrome reads the version from `manifest.json`, so a release could otherwise ship
 * a manifest that disagrees with the npm package — the same class of drift that left
 * the Android app's About card showing 0.1.0 for several releases. One source of
 * truth, applied at build time: `prebuild` runs this automatically.
 *
 * Only `version` is touched; everything else in the manifest stays hand-written.
 */
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const path = "public/manifest.json";
const manifest = JSON.parse(readFileSync(path, "utf8"));

if (!/^\d+(\.\d+){0,3}$/.test(pkg.version)) {
  // Chrome accepts 1-4 dot-separated integers and rejects anything else, so fail
  // here rather than in `chrome://extensions`.
  console.error(`✗ package.json version "${pkg.version}" is not a valid Chrome version`);
  process.exit(1);
}

if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`manifest version → ${pkg.version}`);
} else {
  console.log(`manifest version already ${pkg.version}`);
}
