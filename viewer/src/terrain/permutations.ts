import { compile, createDefaultHost, type MolangValue } from "../molang";
import type {
  RegistryBlock,
  RegistryComponents,
  RegistryMaterial,
  RegistryTransform,
} from "../protocol";

/** Compiled permutation conditions keyed by `"name\\0condition"`. */
const conditionCache = new Map<string, ReturnType<typeof compile> | null>();

/**
 * Clear permutation compile cache (tests).
 */
export function clearPermutationCache(): void {
  conditionCache.clear();
}

/**
 * Merge permutation overrides onto a base component set (shallow + mats replace).
 *
 * @param base - Base components.
 * @param over - Matching permutation components.
 * @returns merged copy.
 */
export function mergeComponents(
  base: RegistryComponents,
  over: RegistryComponents,
): RegistryComponents {
  const out: RegistryComponents = { ...base, ...over };
  if (over.materialInstances || base.materialInstances) {
    out.materialInstances = {
      ...(base.materialInstances ?? {}),
      ...(over.materialInstances ?? {}),
    };
  }
  if (over.boneVisibility || base.boneVisibility) {
    out.boneVisibility = {
      ...(base.boneVisibility ?? {}),
      ...(over.boneVisibility ?? {}),
    };
  }
  if (over.transformation) out.transformation = over.transformation;
  if (over.lightEmission !== undefined) out.lightEmission = over.lightEmission;
  return out;
}

/**
 * Evaluate a permutation condition against block state values.
 * Binds `query.block_property` and `query.block_state` (and `q.` aliases via
 * the Molang parser's query path).
 *
 * @param condition - Molang source.
 * @param states - Block states from the snapshot palette entry.
 * @param cacheKey - Optional cache key prefix (palette block name).
 * @returns true when the condition is truthy.
 */
export function evalPermutationCondition(
  condition: string,
  states: Record<string, unknown>,
  cacheKey = "",
): boolean {
  if (!condition || !condition.trim()) return true;
  const key = `${cacheKey}\0${condition}`;
  let prog = conditionCache.get(key);
  if (prog === undefined) {
    try {
      prog = compile(condition);
    } catch {
      prog = null;
    }
    conditionCache.set(key, prog);
  }
  if (!prog) return false;

  const lookup = (args: MolangValue[]): MolangValue => {
    const name = args[0];
    if (typeof name !== "string") return 0;
    return stateToMolang(states[name] ?? states[stripNs(name)]);
  };
  const host = createDefaultHost({
    queries: {
      block_property: lookup,
      block_state: lookup,
    },
  });
  try {
    const v = prog.evaluate(host);
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0;
    return false;
  } catch {
    return false;
  }
}

/**
 * Apply permutations in order; each matching condition merges its components.
 *
 * @param reg - Palette entry.
 * @param states - Per-block states from the snapshot.
 * @returns effective components after permutation merge.
 */
export function effectiveComponents(
  reg: RegistryBlock,
  states: Record<string, unknown>,
): RegistryComponents {
  let comps: RegistryComponents = { ...(reg.components ?? {}) };
  for (const perm of reg.permutations ?? []) {
    if (!evalPermutationCondition(perm.condition, states, reg.name)) continue;
    comps = mergeComponents(comps, perm.components ?? {});
  }
  return comps;
}

/**
 * Apply minecraft:transformation about the block centre (0.5,0.5,0.5).
 * Translation is in pixels (÷16 → blocks), matching BP JSON.
 *
 * @param x - Block-local X.
 * @param y - Block-local Y.
 * @param z - Block-local Z.
 * @param xf - Transform component.
 * @returns transformed block-local point.
 */
export function transformAboutBlockCenter(
  x: number,
  y: number,
  z: number,
  xf: RegistryTransform,
): [number, number, number] {
  const cx = 0.5;
  const cy = 0.5;
  const cz = 0.5;
  let dx = (x - cx) * (xf.sx ?? 1);
  let dy = (y - cy) * (xf.sy ?? 1);
  let dz = (z - cz) * (xf.sz ?? 1);
  const rx = ((xf.rx ?? 0) * Math.PI) / 180;
  const ry = ((xf.ry ?? 0) * Math.PI) / 180;
  const rz = ((xf.rz ?? 0) * Math.PI) / 180;
  // Extrinsic XYZ: X then Y then Z.
  if (rx) {
    const c = Math.cos(rx);
    const s = Math.sin(rx);
    const ny = dy * c - dz * s;
    const nz = dy * s + dz * c;
    dy = ny;
    dz = nz;
  }
  if (ry) {
    const c = Math.cos(ry);
    const s = Math.sin(ry);
    const nx = dx * c + dz * s;
    const nz = -dx * s + dz * c;
    dx = nx;
    dz = nz;
  }
  if (rz) {
    const c = Math.cos(rz);
    const s = Math.sin(rz);
    const nx = dx * c - dy * s;
    const ny = dx * s + dy * c;
    dx = nx;
    dy = ny;
  }
  return [
    cx + dx + (xf.tx ?? 0) / 16,
    cy + dy + (xf.ty ?? 0) / 16,
    cz + dz + (xf.tz ?? 0) / 16,
  ];
}

/**
 * Pick a material_instances entry for a face or bone name (`*` fills gaps).
 *
 * @param mats - materialInstances map.
 * @param key - Face / bone / material_instance name.
 * @returns material or undefined.
 */
export function materialForKey(
  mats: Record<string, RegistryMaterial> | undefined,
  key: string,
): RegistryMaterial | undefined {
  if (!mats) return undefined;
  return mats[key] ?? mats["*"] ?? mats.side;
}

/**
 * Bedrock defaults face_dimming / ambient_occlusion to true when omitted.
 *
 * @param mat - Material entry.
 * @returns flags.
 */
export function materialFlags(mat: RegistryMaterial | undefined): {
  faceDimming: boolean;
  ambientOcclusion: boolean;
} {
  return {
    faceDimming: mat?.faceDimming !== false,
    ambientOcclusion: mat?.ambientOcclusion !== false,
  };
}

function stateToMolang(v: unknown): MolangValue {
  if (v === undefined || v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  return 0;
}

function stripNs(name: string): string {
  const i = name.indexOf(":");
  return i >= 0 ? name.slice(i + 1) : name;
}
