#!/usr/bin/env node
/**
 * Build the Chrome extension icons from the official Radiant logo mark.
 *
 * Source: src/assets/radiant-mark.png (the vendored Radiant artwork, Apache-2.0) —
 * brand cyan + cream, transparent.
 *
 * Chrome shows 16px in the toolbar and 32px on HiDPI, so the mark is given a solid
 * black plate to sit on: a transparent mark over a light browser theme is
 * unreadable at that size. Ink is deliberately larger than the Android launcher's
 * (0.62 vs 0.56 of the canvas) because 16px is too small for generous padding.
 *
 * Every output is measured after writing and the script fails if the ink is
 * outside tolerance, so the constants below are verified rather than assumed.
 */
import path from "node:path";
import { mkdirSync } from "node:fs";
import {
  load,
  save,
  inkBox,
  crop,
  resizeArea,
  canvas,
  blit,
  inkFractionVsBg,
} from "./lib/image.mjs";

const OUT = "public/icons";
const LOGO = process.env.LOGO_SRC ?? "src/assets/radiant-mark.png";
const BG = [0, 0, 0];
const INK_TARGET = 0.62;
const TOLERANCE = 0.03;
const SIZES = [16, 32, 48, 128];

const source = load(LOGO);
const mark = crop(source, inkBox(source));
console.log(
  `source ${source.width}x${source.height}, ink ${mark.width}x${mark.height}`,
);

mkdirSync(OUT, { recursive: true });

let failures = 0;
for (const size of SIZES) {
  const inkPx = Math.max(2, Math.round(size * INK_TARGET));
  const scaled = resizeArea(mark, inkPx, inkPx);
  const out = blit(canvas(size, size, { bg: BG }), scaled);
  const file = path.join(OUT, `icon-${size}.png`);
  save(file, out);
  const actual = inkFractionVsBg(out, BG);
  const ok = Math.abs(actual - INK_TARGET) <= TOLERANCE;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "OK  " : "FAIL"} ${file.padEnd(28)} ${String(size).padStart(3)}px  ink ${actual.toFixed(3)} (target ${INK_TARGET})`,
  );
}

if (failures > 0) {
  console.error(`${failures} icon(s) outside ink tolerance`);
  process.exit(1);
}
console.log(`\n${SIZES.length} icons written to ${OUT}`);
