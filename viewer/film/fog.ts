/** Film fog starts at this fraction of the loaded radius. End is the radius. */
export const FILM_FOG_START = 0.65;

/**
 * Linear fog distances for film. `loadedRadiusBlocks` is the stream radius
 * in blocks (`hello.radius * 16`): how far columns are kept around the bot,
 * which is the camera in these shots. `near` is 65% of that so the disc
 * fades into the sky before the unloaded edge.
 *
 * @param loadedRadiusBlocks - Loaded radius in blocks.
 * @returns fog near and far in blocks.
 */
export function filmFogRange(loadedRadiusBlocks: number): {
  near: number;
  far: number;
} {
  const far = Math.max(16, loadedRadiusBlocks);
  return { near: far * FILM_FOG_START, far };
}

/**
 * Radius in chunks of a disc with as many columns as are loaded within
 * `maxChunks` of (cx, cz). A server can send less than the granted radius
 * (FILM grants 16 and sends ~10); fog past the real edge shows the void.
 * An area measure, so one missing column near the camera barely moves it.
 *
 * @param keys - Loaded column keys `"x,z"`.
 * @param cx - Camera chunk X.
 * @param cz - Camera chunk Z.
 * @param maxChunks - Stream radius in chunks.
 * @returns equivalent radius in chunks, at most `maxChunks`.
 */
export function loadedDiscRadiusChunks(
  keys: Iterable<string>,
  cx: number,
  cz: number,
  maxChunks: number,
): number {
  let n = 0;
  for (const key of keys) {
    const comma = key.indexOf(",");
    const dx = Number(key.slice(0, comma)) - cx;
    const dz = Number(key.slice(comma + 1)) - cz;
    if (dx * dx + dz * dz <= maxChunks * maxChunks) n++;
  }
  return Math.min(maxChunks, Math.sqrt(n / Math.PI));
}
