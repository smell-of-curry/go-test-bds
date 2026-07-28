/**
 * Per-face / smooth lighting helpers for the terrain mesher.
 *
 * Brightness curve (Bedrock / Java Edition client):
 *   L = level / 15
 *   brightness(level) = L / (4 − 3L)
 * Maps 0 → 0, 15 → 1; mid levels sit on a steep curve (level 7 ≈ 0.368).
 * Combined level = max(blockLight, floor(skyLight * skyDarken)) with
 * skyDarken ∈ [0,1] as a daylight factor (1 = noon; time-of-day is Stage 10 punt).
 */

/** Classic directional face shade: up, down, N/S, E/W. Index = mesher Dir. */
export const FACE_SHADE: ReadonlyArray<number> = [
  0.6, // east +X
  0.6, // west -X
  1.0, // up +Y
  0.5, // down -Y
  0.8, // south +Z
  0.8, // north -Z
];

/**
 * Map a 0..15 light level through the Bedrock/Java brightness curve.
 *
 * @param level - Combined light level 0..15.
 * @returns multiplier in 0..1.
 */
export function lightBrightness(level: number): number {
  const clamped = Math.min(15, Math.max(0, level));
  const L = clamped / 15;
  return L / (4 - 3 * L);
}

/**
 * Combine sky + block light with a daylight factor.
 *
 * @param sky - Sky light 0..15.
 * @param block - Block light 0..15.
 * @param skyDarken - Daylight factor 0..1 (1 = full day).
 * @returns combined level 0..15.
 */
export function combinedLight(
  sky: number,
  block: number,
  skyDarken = 1,
): number {
  const skyEff = Math.floor(sky * skyDarken + 1e-6);
  return Math.max(block & 15, skyEff & 15);
}

/**
 * Ambient-occlusion factor from how many of the three corner-adjacent blocks
 * (two sides + diagonal) occlude. Both sides solid ⇒ treat as fully occluded
 * (classic Minecraft corner rule). Result: 1.0 / 0.8 / 0.6 / 0.4 for 0..3.
 *
 * @param side1Occluded - Side neighbour opaque.
 * @param side2Occluded - Other side neighbour opaque.
 * @param cornerOccluded - Diagonal neighbour opaque.
 * @returns AO multiplier in 0.4..1.
 */
export function aoFactor(
  side1Occluded: boolean,
  side2Occluded: boolean,
  cornerOccluded: boolean,
): number {
  let n = (side1Occluded ? 1 : 0) + (side2Occluded ? 1 : 0);
  if (side1Occluded && side2Occluded) n = 3;
  else if (cornerOccluded) n += 1;
  return 1 - n * 0.2;
}

/**
 * Encode 4096 light levels into the wire nibble packing (for tests).
 *
 * @param levels - Length 4096, values 0..15.
 * @returns base64 of 2048 bytes.
 */
export function encodeSectionLight(levels: Uint8Array): string {
  if (levels.length !== 4096) {
    throw new Error(`encodeSectionLight: need 4096, got ${levels.length}`);
  }
  let bin = "";
  for (let i = 0; i < 2048; i++) {
    const lo = levels[i * 2]! & 0xf;
    const hi = levels[i * 2 + 1]! & 0xf;
    bin += String.fromCharCode(lo | (hi << 4));
  }
  return btoa(bin);
}
