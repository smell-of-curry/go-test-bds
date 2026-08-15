import type {
  BlockDef,
  BlockTexturesField,
  FaceName,
  FlipbookEntry,
  TerrainTextureEntry,
  TerrainVariation,
} from "./types";

/** Parsed blocks.json map (identifier → def). */
export type BlocksJson = Record<string, BlockDef>;

/**
 * Canonicalise a blocks.json key the way the runtime names blocks.
 *
 * Mojang's vanilla `blocks.json` uses bare ids (`stone`); the network /
 * snapshot always sends `minecraft:stone`. Keys that already contain `:`
 * (e.g. `pokeb:apricorn_planks`) are left alone.
 *
 * @param id - Raw key from blocks.json.
 * @returns namespaced block identifier.
 */
export function canonicalizeBlockId(id: string): string {
  if (!id || id.includes(":")) return id;
  return `minecraft:${id}`;
}

/**
 * Parse blocks.json. Strips the `format_version` key and namespaces bare ids.
 *
 * @param raw - JSON root object.
 * @returns block id → definition (keys always namespaced when bare in source).
 */
export function parseBlocksJson(raw: unknown): BlocksJson {
  if (!raw || typeof raw !== "object") return {};
  const out: BlocksJson = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "format_version") continue;
    if (v && typeof v === "object") out[canonicalizeBlockId(k)] = v as BlockDef;
  }
  return out;
}

/**
 * Resolve a blocks.json textures field into per-face short-names.
 * `side` fills any missing cardinal; string form paints every face.
 *
 * @param field - textures or carried_textures value.
 * @returns face → terrain short-name (may be incomplete).
 */
export function expandTexturesField(
  field: BlockTexturesField | undefined,
): Partial<Record<FaceName, string>> {
  if (field == null) return {};
  if (typeof field === "string") {
    return {
      up: field,
      down: field,
      north: field,
      south: field,
      east: field,
      west: field,
      side: field,
    };
  }
  const side = field.side;
  return {
    up: field.up ?? side,
    down: field.down ?? side,
    north: field.north ?? side,
    south: field.south ?? side,
    east: field.east ?? side,
    west: field.west ?? side,
    side,
  };
}

/**
 * Parse terrain_texture.json `texture_data` into short-name → paths.
 *
 * @param raw - JSON root.
 * @returns map of texture short-names.
 */
export function parseTerrainTextureJson(
  raw: unknown,
): Record<string, TerrainTextureEntry> {
  if (!raw || typeof raw !== "object") return {};
  const data = (raw as { texture_data?: unknown }).texture_data;
  if (!data || typeof data !== "object") return {};
  const out: Record<string, TerrainTextureEntry> = {};
  for (const [name, entry] of Object.entries(data as Record<string, unknown>)) {
    out[name] = parseTerrainEntry(entry);
  }
  return out;
}

function parseTerrainEntry(entry: unknown): TerrainTextureEntry {
  if (!entry || typeof entry !== "object") return { paths: [] };
  const textures = (entry as { textures?: unknown }).textures;
  // Bare string.
  if (typeof textures === "string") {
    return { paths: [{ path: normalizeTexPath(textures), weight: 1 }] };
  }
  // Object with path (and optional overlay_color / tint_color — ignored here).
  if (textures && typeof textures === "object" && !Array.isArray(textures)) {
    const o = textures as { path?: string; textures?: string; weight?: number };
    const p = o.path ?? o.textures;
    if (typeof p === "string") {
      return {
        paths: [
          {
            path: normalizeTexPath(p),
            weight: typeof o.weight === "number" ? o.weight : 1,
          },
        ],
      };
    }
    return { paths: [] };
  }
  // Array of strings and/or { path, weight?, overlay_color?, tint_color? }.
  if (Array.isArray(textures)) {
    const paths: TerrainVariation[] = [];
    for (const item of textures) {
      if (typeof item === "string") {
        paths.push({ path: normalizeTexPath(item), weight: 1 });
        continue;
      }
      if (item && typeof item === "object") {
        const o = item as { path?: string; textures?: string; weight?: number };
        const p = o.path ?? o.textures;
        if (typeof p === "string") {
          paths.push({
            path: normalizeTexPath(p),
            weight: typeof o.weight === "number" ? o.weight : 1,
          });
        }
      }
    }
    return { paths };
  }
  return { paths: [] };
}

/**
 * Parse flipbook_textures.json (array or `{ flipbook_textures: [...] }`).
 *
 * @param raw - JSON root.
 * @returns flipbook entries keyed by atlas_tile when present.
 */
export function parseFlipbookJson(raw: unknown): FlipbookEntry[] {
  let arr: unknown[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (raw && typeof raw === "object") {
    const nested = (raw as { flipbook_textures?: unknown }).flipbook_textures;
    if (Array.isArray(nested)) arr = nested;
  }
  const out: FlipbookEntry[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const flip =
      typeof o.flipbook_texture === "string" ? o.flipbook_texture : null;
    const tile = typeof o.atlas_tile === "string" ? o.atlas_tile : null;
    if (!flip || !tile) continue;
    out.push({
      flipbookTexture: stripExt(flip),
      atlasTile: tile,
      ticksPerFrame:
        typeof o.ticks_per_frame === "number" ? o.ticks_per_frame : 1,
      frames: Array.isArray(o.frames)
        ? o.frames.filter((n): n is number => typeof n === "number")
        : null,
      blendFrames: o.blend_frames === true,
    });
  }
  return out;
}

/**
 * Deterministic weighted pick from variations using block position.
 * Same (x,y,z, paths) always yields the same index — golden frames stay stable.
 *
 * @param paths - Weighted path list.
 * @param x - Block X.
 * @param y - Block Y.
 * @param z - Block Z.
 * @returns chosen path index, or -1 when empty.
 */
export function pickVariationIndex(
  paths: readonly TerrainVariation[],
  x: number,
  y: number,
  z: number,
): number {
  if (paths.length === 0) return -1;
  if (paths.length === 1) return 0;
  let total = 0;
  for (const p of paths) total += Math.max(0, p.weight);
  if (total <= 0) return 0;
  const h = hashPos(x, y, z);
  let slot = h % total;
  for (let i = 0; i < paths.length; i++) {
    slot -= Math.max(0, paths[i]!.weight);
    if (slot < 0) return i;
  }
  return paths.length - 1;
}

/**
 * Flipbook frame index for a game tick (not wall clock).
 *
 * @param entry - Flipbook definition.
 * @param tick - Snapshot tick.
 * @param frameCount - Frame count from image height / tile size when frames omitted.
 * @returns frame index into the strip (or into `entry.frames`).
 */
export function flipbookFrameAt(
  entry: FlipbookEntry,
  tick: number,
  frameCount: number,
): number {
  const seq =
    entry.frames && entry.frames.length > 0
      ? entry.frames
      : Array.from({ length: Math.max(1, frameCount) }, (_, i) => i);
  const tpf = Math.max(1, entry.ticksPerFrame);
  const i = Math.floor(Math.max(0, tick) / tpf) % seq.length;
  return seq[i]!;
}

/**
 * @param path - Texture path possibly with extension.
 * @returns path without trailing `.png`.
 */
export function stripExt(path: string): string {
  return path.replace(/\\/g, "/").replace(/\.png$/i, "");
}

/**
 * Normalise a terrain texture path from terrain_texture.json.
 * Accepts with/without `textures/` prefix and with/without `.png`.
 *
 * @param path - Raw path from pack JSON.
 * @returns pack-relative path without `.png`, with `textures/` when implied.
 */
export function normalizeTexPath(path: string): string {
  let p = stripExt(path);
  if (
    !p.startsWith("textures/") &&
    (p.startsWith("blocks/") || p.startsWith("items/"))
  ) {
    p = `textures/${p}`;
  }
  return p;
}

/**
 * Stable 32-bit hash of block position (FNV-1a style).
 *
 * @param x - Block X.
 * @param y - Block Y.
 * @param z - Block Z.
 * @returns non-negative integer.
 */
export function hashPos(x: number, y: number, z: number): number {
  let h = 2166136261;
  h = Math.imul(h ^ (x | 0), 16777619);
  h = Math.imul(h ^ (y | 0), 16777619);
  h = Math.imul(h ^ (z | 0), 16777619);
  return h >>> 0;
}
