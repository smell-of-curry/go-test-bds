import type { AssetClient } from "./assetClient";
import { biomeIndex, columnKey } from "../protocol";
import type { WorldState } from "../store";
import {
  BIOME_CLIMATE,
  DEFAULT_WATER,
  type BiomeClimate,
} from "./biomeClimate";
import type { BiomeAt, TintRgb } from "./types";

/**
 * Grass / foliage / water multipliers when the column has no biome id.
 * Textures stay as authored (white).
 */
export const UNTINTED: Record<"grass" | "foliage" | "water", TintRgb> = {
  grass: { r: 1, g: 1, b: 1 },
  foliage: { r: 1, g: 1, b: 1 },
  water: { r: 1, g: 1, b: 1 },
};

/**
 * Used only when the grass/foliage colormap failed to load.
 * Matches the previous hand plains tint so fixture renders stay stable.
 */
const NO_MAP_GRASS: TintRgb = { r: 0.57, g: 0.75, b: 0.35 };
const NO_MAP_FOLIAGE: TintRgb = { r: 0.45, g: 0.7, b: 0.25 };

/** Birch / spruce / mangrove leaf colors (solid vanilla colormaps). */
const BIRCH: TintRgb = bytes(0x80, 0xa7, 0x55);
const SPRUCE: TintRgb = bytes(0x61, 0x99, 0x61);
const MANGROVE: TintRgb = bytes(0x8d, 0xb1, 0x27);
/** Redstone dust at signal 0; the texture is gray and the client tints it. */
// ponytail: every wire draws unpowered; tint by `redstone_signal` if powered circuits ever matter on film.
const REDSTONE: TintRgb = bytes(0x4c, 0x00, 0x00);

/** Swamp grass pair baked into `swamp_grass.png` (left / right). */
const SWAMP_DARK: TintRgb = bytes(0x4c, 0x76, 0x3c);
const SWAMP_LIGHT: TintRgb = bytes(0x6a, 0x70, 0x39);

const PLAINS_CLIMATE: BiomeClimate = BIOME_CLIMATE.plains ?? {
  t: 0.8,
  d: 0.4,
  w: DEFAULT_WATER,
};

/**
 * Newer names some encoders emit, mapped onto the Bedrock id in the table.
 * Dragonfly's `String()` already uses the Bedrock ids (`savanna`, `mesa`).
 */
const BIOME_ALIAS: Record<string, string> = {
  swamp: "swampland",
  swamp_hills: "swampland_mutated",
  badlands: "mesa",
  badlands_plateau: "mesa_plateau",
  wooded_badlands_plateau: "mesa_plateau_stone",
  eroded_badlands: "mesa_bryce",
  dark_forest: "roofed_forest",
  dark_forest_hills: "roofed_forest_mutated",
  windswept_hills: "extreme_hills",
  windswept_savanna: "savanna_mutated",
  snowy_plains: "ice_plains",
  nether_wastes: "hell",
};

export interface Colormap {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

let grassMap: Colormap | null = null;
let foliageMap: Colormap | null = null;
let swampMap: Colormap | null = null;
let dryMap: Colormap | null = null;
let warnedMissing = false;

/**
 * Install colormaps. Pass null to clear. Tests call this with decoded PNGs;
 * the film page loads them from the pack stack.
 *
 * @param maps - Images, or null to clear every channel.
 */
export function setBiomeColormaps(
  maps: {
    grass?: Colormap | null;
    foliage?: Colormap | null;
    swampGrass?: Colormap | null;
    dryFoliage?: Colormap | null;
  } | null,
): void {
  if (!maps) {
    grassMap = null;
    foliageMap = null;
    swampMap = null;
    dryMap = null;
    return;
  }
  if ("grass" in maps) grassMap = maps.grass ?? null;
  if ("foliage" in maps) foliageMap = maps.foliage ?? null;
  if ("swampGrass" in maps) swampMap = maps.swampGrass ?? null;
  if ("dryFoliage" in maps) dryMap = maps.dryFoliage ?? null;
}

/**
 * Load vanilla colormap PNGs from the pack stack (winner pack).
 * Missing files leave that channel empty; tint then uses the plains fallback.
 *
 * Climate itself is the checked-in table, not this fetch: takes recorded
 * before BiomeDefinitionList have no per-biome temperature on the wire.
 *
 * @param client - Pack asset client.
 */
export async function loadBiomeColormaps(client: AssetClient): Promise<void> {
  const [grass, foliage, swampGrass, dryFoliage] = await Promise.all([
    readColormap(client, "textures/colormap/grass.png"),
    readColormap(client, "textures/colormap/foliage.png"),
    readColormap(client, "textures/colormap/swamp_grass.png"),
    readColormap(client, "textures/colormap/dry_foliage.png"),
  ]);
  if ((!grass || !foliage) && !warnedMissing) {
    warnedMissing = true;
    console.warn(
      "[terrain] grass/foliage colormap missing; tint falls back to plains",
    );
  }
  grassMap = grass;
  foliageMap = foliage;
  swampMap = swampGrass;
  dryMap = dryFoliage;
}

/**
 * Vanilla colormap index.
 * `t = clamp(temp)`, `d = clamp(downfall) * t`, then
 * `((1-t)*(width-1), (1-d)*(height-1))` truncated toward zero.
 *
 * @param temp - Biome temperature (may be outside 0..1; clamped).
 * @param downfall - Biome downfall.
 * @param width - Colormap width in pixels.
 * @param height - Colormap height in pixels.
 * @returns integer pixel coordinates.
 */
export function colormapCoords(
  temp: number,
  downfall: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const t = clamp01(temp);
  const d = clamp01(downfall) * t;
  const x = Math.floor((1 - t) * (width - 1));
  const y = Math.floor((1 - d) * (height - 1));
  return {
    x: Math.min(width - 1, Math.max(0, x)),
    y: Math.min(height - 1, Math.max(0, y)),
  };
}

/**
 * Sample one colormap pixel. Null image → null (caller picks a fallback).
 *
 * @param img - Decoded colormap.
 * @param temp - Biome temperature.
 * @param downfall - Biome downfall.
 * @returns RGB 0..1, or null when `img` is null.
 */
export function sampleColormap(
  img: Colormap | null,
  temp: number,
  downfall: number,
): TintRgb | null {
  if (!img) return null;
  const { x, y } = colormapCoords(temp, downfall, img.width, img.height);
  return pixelAt(img, x, y);
}

/**
 * Climate row for a biome id, or null when the id is not in the vanilla table.
 *
 * @param id - `minecraft:savanna` or `savanna`.
 * @returns climate, or null.
 */
export function climateFor(id: string): BiomeClimate | null {
  const bare = id.startsWith("minecraft:") ? id.slice(10) : id;
  const key = BIOME_ALIAS[bare] ?? bare;
  return BIOME_CLIMATE[key] ?? null;
}

/**
 * Normalise a wire biome palette entry to a `minecraft:…` id.
 * Numeric / unknown entries return null so tint falls back to untinted.
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
 *
 * Birch / spruce / mangrove are fixed leaf colors (not biome-sampled).
 * A null biome id returns untinted white. A named biome missing from the
 * vanilla table uses plains climate (the unknown-biome fallback).
 *
 * @param biomeAt - Biome lookup (null → untinted).
 * @param channel - Tint channel.
 * @param x - Block X (swamp grass noise).
 * @param z - Block Z.
 * @returns RGB multipliers in 0..1.
 */
export function tintAt(
  biomeAt: BiomeAt | null | undefined,
  channel:
    | "none"
    | "grass"
    | "foliage"
    | "water"
    | "birch"
    | "spruce"
    | "mangrove"
    | "dry"
    | "redstone",
  x: number,
  z: number,
): TintRgb {
  if (channel === "none") return { r: 1, g: 1, b: 1 };
  if (channel === "birch") return BIRCH;
  if (channel === "spruce") return SPRUCE;
  if (channel === "mangrove") return MANGROVE;
  if (channel === "redstone") return REDSTONE;
  if (!biomeAt) return untinted(channel);
  const id = biomeAt(x, z);
  // Missing or unknown biome → plains climate: the client never draws
  // untinted (gray) grass, and older takes ship columns before their biomes.
  const climate = (id == null ? null : climateFor(id)) ?? PLAINS_CLIMATE;
  return tintFromClimate(climate, channel, x, z);
}

function tintFromClimate(
  climate: BiomeClimate,
  channel: "grass" | "foliage" | "water" | "dry",
  x: number,
  z: number,
): TintRgb {
  if (channel === "water") return bytesToTint(climate.w ?? DEFAULT_WATER);
  if (channel === "grass") {
    if (climate.g === "noise") return swampGrass(x, z);
    if (climate.g) return bytesToTint(climate.g);
    return sampleColormap(grassMap, climate.t, climate.d) ?? NO_MAP_GRASS;
  }
  if (channel === "foliage") {
    if (climate.f) return bytesToTint(climate.f);
    return sampleColormap(foliageMap, climate.t, climate.d) ?? NO_MAP_FOLIAGE;
  }
  return sampleColormap(dryMap, climate.t, climate.d) ?? { r: 1, g: 1, b: 1 };
}

function untinted(channel: "grass" | "foliage" | "water" | "dry"): TintRgb {
  if (channel === "dry") return { r: 1, g: 1, b: 1 };
  return UNTINTED[channel];
}

/**
 * Swamp grass picks the dark or light half of `swamp_grass.png`.
 * ponytail: 2D value noise, seed 2345, threshold -0.1 (Java's swamp test).
 * Not bit-identical to Bedrock's noise; upgrade path is the client generator.
 * Spatial scale is vanilla's 0.0225.
 *
 * @param x - Block X.
 * @param z - Block Z.
 * @returns grass multiplier.
 */
function swampGrass(x: number, z: number): TintRgb {
  const dark = swampNoise(x, z) < -0.1;
  if (swampMap) {
    return pixelAt(swampMap, dark ? 0 : swampMap.width - 1, 0);
  }
  return dark ? SWAMP_DARK : SWAMP_LIGHT;
}

function swampNoise(x: number, z: number): number {
  return valueNoise(x * 0.0225, z * 0.0225);
}

const PERM = (() => {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = 2345 >>> 0;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = p[i]!;
    p[i] = p[j]!;
    p[j] = tmp;
  }
  return p;
})();

function valueNoise(x: number, z: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const xf = x - x0;
  const zf = z - z0;
  const u = fade(xf);
  const v = fade(zf);
  const aa = PERM[(PERM[x0 & 255]! + z0) & 255]!;
  const ab = PERM[(PERM[x0 & 255]! + ((z0 + 1) & 255)) & 255]!;
  const ba = PERM[(PERM[(x0 + 1) & 255]! + z0) & 255]!;
  const bb = PERM[(PERM[(x0 + 1) & 255]! + ((z0 + 1) & 255)) & 255]!;
  const x1 = lerp(grad(aa, xf, zf), grad(ba, xf - 1, zf), u);
  const x2 = lerp(grad(ab, xf, zf - 1), grad(bb, xf - 1, zf - 1), u);
  return lerp(x1, x2, v);
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function grad(h: number, x: number, z: number): number {
  switch (h & 3) {
    case 0:
      return x + z;
    case 1:
      return -x + z;
    case 2:
      return x - z;
    default:
      return -x - z;
  }
}

function pixelAt(img: Colormap, x: number, y: number): TintRgb {
  const xx = Math.max(0, Math.min(img.width - 1, x));
  const yy = Math.max(0, Math.min(img.height - 1, y));
  const i = (yy * img.width + xx) * 4;
  return {
    r: img.rgba[i]! / 255,
    g: img.rgba[i + 1]! / 255,
    b: img.rgba[i + 2]! / 255,
  };
}

function bytes(r: number, g: number, b: number): TintRgb {
  return { r: r / 255, g: g / 255, b: b / 255 };
}

function bytesToTint(c: readonly [number, number, number]): TintRgb {
  return bytes(c[0], c[1], c[2]);
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

async function readColormap(
  client: AssetClient,
  path: string,
): Promise<Colormap | null> {
  try {
    const bmp = await client.fetchImage(path);
    if (!bmp) return null;
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return { width: bmp.width, height: bmp.height, rgba: img.data };
  } catch {
    return null;
  }
}
