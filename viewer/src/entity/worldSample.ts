/**
 * Block + light lookups against the decoded column store.
 * Missing columns use the mesher's omission defaults (sky 15, block 0)
 * so an unloaded neighbour does not paint a black entity.
 */

import type { Block } from "../protocol";
import { columnKey, sectionIndex } from "../protocol";
import type { WorldState } from "../store";

export interface SampledCell {
  block: Block | null;
  sky: number;
  blockLight: number;
}

/**
 * @param state - World, or null before the first keyframe.
 * @param wx - World X (any real; floored).
 * @param wy - World Y.
 * @param wz - World Z.
 * @returns palette entry and light nibbles.
 */
export function sampleCell(
  state: WorldState | null | undefined,
  wx: number,
  wy: number,
  wz: number,
): SampledCell {
  if (!state) return { block: null, sky: 15, blockLight: 0 };
  const x = Math.floor(wx);
  const y = Math.floor(wy);
  const z = Math.floor(wz);
  const cx = Math.floor(x / 16);
  const cz = Math.floor(z / 16);
  const sy = Math.floor(y / 16);
  const col = state.columns.get(columnKey(cx, cz));
  if (!col || col.state === "requested") {
    return { block: null, sky: 15, blockLight: 0 };
  }
  const sec = col.sections.get(sy);
  if (!sec) return { block: null, sky: 15, blockLight: 0 };
  const i = sectionIndex(x - cx * 16, y - sy * 16, z - cz * 16);
  return {
    block: sec.palette[sec.indices[i]!] ?? null,
    sky: sec.skyLight[i] ?? 15,
    blockLight: sec.blockLight[i] ?? 0,
  };
}

/**
 * Cells a blob shadow can land on. Air and light-block are empty; water
 * and plants count as a surface (the shadow sits on that cell's top).
 *
 * @param block - Palette entry, or null when the section has no cell.
 * @returns true when the shadow should keep searching downward.
 */
export function isShadowEmpty(block: Block | null): boolean {
  if (!block) return true;
  const n = block.name;
  return (
    n === "minecraft:air" ||
    n === "minecraft:cave_air" ||
    n === "minecraft:void_air" ||
    n === "minecraft:structure_void" ||
    n === "minecraft:light_block"
  );
}
