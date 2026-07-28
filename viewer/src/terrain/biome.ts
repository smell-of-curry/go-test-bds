import type { BiomeAt, TintRgb } from "./types";

/** Default grass / foliage / water colours when biome is unknown (null). */
export const UNTINTED: Record<"grass" | "foliage" | "water", TintRgb> = {
  grass: { r: 1, g: 1, b: 1 },
  foliage: { r: 1, g: 1, b: 1 },
  water: { r: 1, g: 1, b: 1 },
};

/** Rough vanilla plains defaults used when a biome id is known but not mapped. */
const PLAINS: Record<"grass" | "foliage" | "water", TintRgb> = {
  grass: { r: 0.57, g: 0.75, b: 0.35 },
  foliage: { r: 0.45, g: 0.7, b: 0.25 },
  water: { r: 0.25, g: 0.45, b: 0.9 },
};

const BIOME_TINTS: Record<string, Partial<typeof PLAINS>> = {
  "minecraft:plains": PLAINS,
  "minecraft:forest": {
    grass: { r: 0.5, g: 0.72, b: 0.3 },
    foliage: { r: 0.4, g: 0.65, b: 0.2 },
  },
  "minecraft:desert": {
    grass: { r: 0.75, g: 0.7, b: 0.35 },
    foliage: { r: 0.7, g: 0.65, b: 0.3 },
    water: { r: 0.2, g: 0.4, b: 0.85 },
  },
  "minecraft:swamp": {
    grass: { r: 0.45, g: 0.5, b: 0.25 },
    foliage: { r: 0.4, g: 0.45, b: 0.2 },
    water: { r: 0.35, g: 0.45, b: 0.4 },
  },
};

/**
 * Resolve a tint RGB for a channel at a block column.
 * When `biomeAt` returns null, returns untinted white (texture as authored).
 *
 * @param biomeAt - Biome lookup (null → untinted).
 * @param channel - Tint channel.
 * @param x - Block X.
 * @param z - Block Z.
 * @returns RGB multipliers in 0..1.
 */
export function tintAt(
  biomeAt: BiomeAt | null | undefined,
  channel: "grass" | "foliage" | "water" | "none",
  x: number,
  z: number,
): TintRgb {
  if (channel === "none") return { r: 1, g: 1, b: 1 };
  if (!biomeAt) return UNTINTED[channel];
  const id = biomeAt(x, z);
  if (id == null) return UNTINTED[channel];
  const table = BIOME_TINTS[id];
  return table?.[channel] ?? PLAINS[channel];
}

/**
 * Go must expose per-column (or per-block) biome ids on the snapshot for tint
 * to light up. Until then, pass `biomeAt: () => null` or omit it.
 *
 * Required wire shape (proposal):
 * - On each `Column`: `"biome": "minecraft:plains"` (single biome per column),
 *   **or** `"biomes": "<base64 uint16[256]>"` + `"biomePalette": ["minecraft:plains", …]`
 *   for 16×16 xz. Height-varying biomes can wait.
 * - Decoder fills a `biomeAt(x,z)` the mesher already accepts.
 */
export const BIOME_SNAPSHOT_NOTE = `
Column (or section) must carry biome identity. Minimal: column.biome string.
Better: 16×2D biome palette like block layers. Viewer already accepts BiomeAt;
store should build it from the new field. biomes_client.json supplies colours.
`.trim();
