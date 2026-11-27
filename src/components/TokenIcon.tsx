import type { TokenBalance } from "../lib/glyphs";

/**
 * A Glyph token icon: the payload's raster image as a data: URI (only
 * png/jpeg/gif/webp ever reach this — SVG/markup is dropped in glyphs.ts), or
 * a letter fallback disc built from the name. No <img> with attacker-supplied
 * markup is ever rendered from a non-raster source.
 */
export default function TokenIcon({
  token,
  size = 40,
}: {
  token: TokenBalance;
  size?: number;
}) {
  const icon = token.metadata?.iconDataUri;
  const name = token.metadata?.name ?? token.metadata?.ticker ?? "";
  const initial = name.trim().charAt(0).toUpperCase() || "★";
  if (icon) {
    return (
      <img
        className="token-icon"
        alt=""
        src={icon}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="token-icon token-icon-fallback"
      style={{ width: size, height: size, fontSize: Math.max(12, size * 0.42) }}
      aria-hidden="true"
    >
      {initial}
    </div>
  );
}