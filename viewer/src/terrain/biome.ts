import { biomeIndex, columnKey } from "../protocol";
import type { WorldState } from "../store";
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
  "minecraft:cherry_grove": {
    grass: { r: 0.7, g: 0.7, b: 0.5 },
    foliage: { r: 0.85, g: 0.55, b: 0.7 },
    water: { r: 0.3, g: 0.5, b: 0.9 },
  },
};

/**
 * Normalise a wire biome palette entry to a `minecraft:…` id.
 * Numeric / unknown entries return null so tint falls back to untinted/plains.
 *
 * @param entry - Palette entry from the snapshot (`plains`, `minecraft:plains`, or id).
 * @returns namespaced biome id, or null when unusable.
 */
export function normalizeBiomeId(
  entry: string | number | null | undefined,
): string | null {
  if (entry == null) return null;
  if (typeof entry === "number") return null;
  const s = entry.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return null;
  if (s.includes(":")) return s;
  return `minecraft:${s}`;
}

/**
 * Look up the surface biome id at a block column from stored wire data.
 *
 * @param state - World state.
 * @param x - Block X.
 * @param z - Block Z.
 * @returns namespaced biome id, or null when missing/unknown.
 */
export function biomeIdAt(
  state: WorldState,
  x: number,
  z: number,
): string | null {
  const col = state.columns.get(columnKey(x >> 4, z >> 4));
  if (!col?.biomeIndices || !col.biomePalette?.length) return null;
  const idx = col.biomeIndices[biomeIndex(x & 15, z & 15)]!;
  return normalizeBiomeId(col.biomePalette[idx]);
}

/**
 * Build a {@link BiomeAt} that reads column `biomePalette`/`biomes` from state.
 *
 * @param state - World state (captured by reference; call during mesh with current state).
 * @returns lookup function.
 */
export function biomeAtFromState(state: WorldState): BiomeAt {
  return (x, z) => biomeIdAt(state, x, z);
}

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
