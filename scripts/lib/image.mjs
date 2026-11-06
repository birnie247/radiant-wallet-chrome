/**
 * Shared PNG compositing helpers (used by build-icons.mjs and
 * build-store-assets.mjs).
 *
 * Everything works on plain {width, height, data: Buffer(RGBA)} objects so the
 * callers stay tiny. Downscaling is an area average computed in premultiplied
 * space, which is what keeps the cyan/cream logo edges from picking up dark
 * fringes when it is shrunk from 2500px to 48px.
 */
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

export const load = (file) => {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: Buffer.from(png.data) };
};

export const save = (file, img) => {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
};

/** Bounding box of pixels with meaningful alpha. */
export function inkBox(img) {
  const { width, height, data } = img;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(width * y + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("source image has no visible pixels");
  return { minX, minY, maxX, maxY };
}

export function crop(img, box) {
  const w = box.maxX - box.minX + 1;
  const h = box.maxY - box.minY + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((box.minY + y) * img.width + box.minX) * 4;
    img.data.copy(out, y * w * 4, from, from + w * 4);
  }
  return { width: w, height: h, data: out };
}

/** Area-average downscale, premultiplied so edges don't pick up dark fringes. */
export function resizeArea(img, dw, dh) {
  const { width: sw, height: sh, data } = img;
  const out = Buffer.alloc(dw * dh * 4);
  const xScale = sw / dw;
  const yScale = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * yScale);
    const sy1 = Math.min(sh, Math.max(sy0 + 1, Math.ceil((y + 1) * yScale)));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * xScale);
      const sx1 = Math.min(sw, Math.max(sx0 + 1, Math.ceil((x + 1) * xScale)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sw * sy + sx) * 4;
          const al = data[i + 3];
          r += data[i] * al;
          g += data[i + 1] * al;
          b += data[i + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (dw * y + x) * 4;
      if (a === 0) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      } else {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / n);
      }
    }
  }
  return { width: dw, height: dh, data: out };
}

/** Rectangular canvas, transparent or filled (optionally as a circle). */
export function canvas(width, height, { bg = null, circle = false } = {}) {
  const out = Buffer.alloc(width * height * 4);
  if (bg) {
    const [r, g, b] = bg;
    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;
    const radius = Math.min(width, height) / 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (width * y + x) * 4;
        let alpha = 1;
        if (circle) {
          const d = Math.hypot(x - cx, y - cy);
          // 1px soft edge so the circle mask does not alias hard.
          alpha = Math.max(0, Math.min(1, radius - d));
        }
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = Math.round(alpha * 255);
      }
    }
  }
  return { width, height, data: out };
}

/** Alpha-composite `ink` centred onto `base`. */
export function blit(base, ink) {
  const { width: bw, height: bh, data: bd } = base;
  const { width: iw, height: ih, data: id } = ink;
  const ox = Math.round((bw - iw) / 2);
  const oy = Math.round((bh - ih) / 2);
  for (let y = 0; y < ih; y++) {
    const by = oy + y;
    if (by < 0 || by >= bh) continue;
    for (let x = 0; x < iw; x++) {
      const bx = ox + x;
      if (bx < 0 || bx >= bw) continue;
      const si = (iw * y + x) * 4;
      const sa = id[si + 3] / 255;
      if (sa === 0) continue;
      const di = (bw * by + bx) * 4;
      const da = bd[di + 3] / 255;
      const outA = sa + da * (1 - sa);
      if (outA === 0) continue;
      for (let c = 0; c < 3; c++) {
        bd[di + c] = Math.round(
          (id[si + c] * sa + bd[di + c] * da * (1 - sa)) / outA,
        );
      }
      bd[di + 3] = Math.round(outA * 255);
    }
  }
  return base;
}

/** Ink span as a fraction of width/height (larger of the two). */
export function inkFraction(img) {
  const b = inkBox(img);
  return Math.max(b.maxX - b.minX + 1, b.maxY - b.minY + 1) / img.width;
}

/**
 * Ink span for an image with an opaque background: measure pixels that differ
 * from that background (otherwise the whole canvas counts as ink).
 */
export function inkFractionVsBg(img, bg, tol = 40) {
  const { width, height, data } = img;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) * 4;
      if (data[i + 3] < 40) continue;
      const delta =
        Math.abs(data[i] - bg[0]) +
        Math.abs(data[i + 1] - bg[1]) +
        Math.abs(data[i + 2] - bg[2]);
      if (delta > tol) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return 0;
  return Math.max(maxX - minX + 1, maxY - minY + 1) / width;
}
