import {
  parseBlocksJson,
  parseFlipbookJson,
  parseTerrainTextureJson,
  type BlocksJson,
} from "./parse";
import type { FlipbookEntry, TerrainTextureEntry } from "./types";
import type { BlockDef } from "./types";

/**
 * Merge one block def over another. Later packs may add `sound` without
 * `textures` — those must not wipe the baseline appearance.
 *
 * @param base - Lower-priority def (or empty).
 * @param overlay - Higher-priority def.
 * @returns merged def.
 */
export function mergeBlockDef(base: BlockDef, overlay: BlockDef): BlockDef {
  return {
    ...base,
    ...overlay,
    textures: overlay.textures ?? base.textures,
    carried_textures: overlay.carried_textures ?? base.carried_textures,
  };
}

/**
 * Merge blocks.json objects from low → high priority packs.
 *
 * @param layers - Parsed roots in stack order (vanilla first).
 * @returns merged block id → def map.
 */
export function mergeBlocksLayers(layers: unknown[]): BlocksJson {
  const out: BlocksJson = {};
  for (const raw of layers) {
    const layer = parseBlocksJson(raw);
    for (const [id, def] of Object.entries(layer)) {
      const prev = out[id];
      out[id] = prev ? mergeBlockDef(prev, def) : def;
    }
  }
  return out;
}

/**
 * Merge terrain_texture.json `texture_data` from low → high priority.
 * Later packs replace a short-name entry entirely.
 *
 * @param layers - Parsed roots in stack order.
 * @returns merged short-name → entry map.
 */
export function mergeTerrainLayers(
  layers: unknown[],
): Record<string, TerrainTextureEntry> {
  const out: Record<string, TerrainTextureEntry> = {};
  for (const raw of layers) {
    const layer = parseTerrainTextureJson(raw);
    Object.assign(out, layer);
  }
  return out;
}

/**
 * Merge flipbook lists; later pack entries with the same `atlas_tile` win.
 *
 * @param layers - Parsed roots in stack order.
 * @returns merged flipbook entries.
 */
export function mergeFlipbookLayers(layers: unknown[]): FlipbookEntry[] {
  const byTile = new Map<string, FlipbookEntry>();
  for (const raw of layers) {
    for (const e of parseFlipbookJson(raw)) {
      byTile.set(e.atlasTile, e);
    }
  }
  return [...byTile.values()];
}
