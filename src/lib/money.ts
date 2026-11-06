/**
 * Photon / RXD money helpers.
 *
 * Radiant's base unit is the photon: 1 RXD = 100,000,000 photons.
 * All arithmetic is BigInt — never float — because 8-decimal token amounts
 * blow past IEEE-754 integer precision quickly.
 */
export const PHOTONS_PER_RXD = 100_000_000n;
export const DECIMALS = 8;

/** Format photons as a trimmed RXD decimal string. */
export function formatRxd(photons: bigint, maxFractionDigits = DECIMALS): string {
  const negative = photons < 0n;
  const abs = negative ? -photons : photons;
  const whole = abs / PHOTONS_PER_RXD;
  const frac = abs % PHOTONS_PER_RXD;

  let fracStr = frac.toString().padStart(DECIMALS, "0").slice(0, maxFractionDigits);
  fracStr = fracStr.replace(/0+$/, "");

  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${wholeStr}${fracStr ? "." + fracStr : ""}`;
}

/** Short display for large/small figures, e.g. list rows. */
export function formatRxdCompact(photons: bigint): string {
  return formatRxd(photons, 6);
}

/**
 * Parse a user-typed RXD amount into photons.
 * Throws Error with a user-facing message on bad input.
 */
export function parseRxd(input: string): bigint {
  const raw = input.trim().replace(/,/g, "");
  if (!raw) throw new Error("Enter an amount");
  if (!/^\d*(\.\d*)?$/.test(raw)) throw new Error("Numbers only");
  if (raw === "." || raw === "") throw new Error("Enter an amount");

  const [wholePart, fracPart = ""] = raw.split(".");
  if (fracPart.length > DECIMALS) {
    throw new Error(`At most ${DECIMALS} decimal places`);
  }
  const whole = BigInt(wholePart || "0");
  const frac = BigInt((fracPart + "0".repeat(DECIMALS)).slice(0, DECIMALS) || "0");
  const photons = whole * PHOTONS_PER_RXD + frac;
  if (photons <= 0n) throw new Error("Amount must be greater than zero");
  return photons;
}

/** Shorten a txid or address for display. */
export function shortId(value: string, head = 8, tail = 6): string {
  if (!value) return "";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
