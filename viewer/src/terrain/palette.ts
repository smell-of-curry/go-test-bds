import type { Registries, RegistryBlock, RegistryMaterial } from "../protocol";
import { FALLBACK_TEXTURE, NEUTRAL_TEXTURE } from "./atlas";
import type { FaceAppearance, RenderClass } from "./types";

type Cardinal = "up" | "down" | "north" | "south" | "east" | "west";

const CARDINALS: Cardinal[] = ["up", "down", "north", "south", "east", "west"];

/** Why a palette entry did not resolve to a pack texture. */
export type PaletteMissReason =
  | "no_material_instances"
  | "empty_textures"
  | "atlas_miss"
  | "neutral_no_materials";

export interface PaletteEntryCoverage {
  name: string;
  hasMaterialInstances: boolean;
  textureShortNames: string[];
  /** True when every referenced short-name is in the atlas (not fallback UV). */
  texturesResolved: boolean;
  /** True when geometry string present (still meshed as a cube this round). */
  hasGeometry: boolean;
  reason?: PaletteMissReason;
  detail?: string;
}

export interface PaletteCoverageReport {
  entryCount: number;
  withMaterialInstances: number;
  texturesResolved: number;
  neutralNoMaterials: number;
  atlasMiss: number;
  withGeometry: number;
  entries: PaletteEntryCoverage[];
}

/**
 * Index `registries.blocks` by name for O(1) resolve.
 *
 * @param registries - Keyframe registries or null.
 * @returns name → block entry.
 */
export function indexRegistryBlocks(
  registries: Registries | null | undefined,
): Map<string, RegistryBlock> {
  const out = new Map<string, RegistryBlock>();
  if (!registries?.blocks) return out;
  for (const b of registries.blocks) {
    if (b?.name) out.set(b.name, b);
  }
  return out;
}

/**
 * Collect terrain short-names referenced by palette material_instances.
 *
 * @param registries - Keyframe registries or null.
 * @returns short-name set for atlas packing.
 */
export function textureNamesFromRegistries(
  registries: Registries | null | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!registries?.blocks) return out;
  for (const b of registries.blocks) {
    const mats = b.components?.materialInstances;
    if (!mats) continue;
    for (const m of Object.values(mats)) {
      if (m?.texture) out.add(m.texture);
    }
  }
  return out;
}

/**
 * Pick the material entry for a face (`*` fills gaps).
 *
 * @param mats - materialInstances map.
 * @param face - Cardinal face.
 * @returns material or undefined.
 */
export function materialForFace(
  mats: Record<string, RegistryMaterial> | undefined,
  face: Cardinal,
): RegistryMaterial | undefined {
  if (!mats) return undefined;
  return mats[face] ?? mats["*"] ?? mats.side;
}

/**
 * Map Bedrock `render_method` onto the mesher's render class.
 *
 * @param method - renderMethod from a material entry (any face).
 * @returns cutout / translucent / opaque.
 */
export function renderClassFromMethod(method: string | undefined): RenderClass {
  const m = (method ?? "opaque").toLowerCase();
  if (m === "alpha_test" || m === "alpha_test_single_sided") return "cutout";
  if (m === "blend") return "translucent";
  return "opaque";
}

/**
 * Build per-face appearances from palette material_instances.
 *
 * @param mats - materialInstances map.
 * @returns faces + renderClass, or null when no usable textures.
 */
export function facesFromMaterialInstances(
  mats: Record<string, RegistryMaterial> | undefined,
): {
  faces: Record<Cardinal, FaceAppearance>;
  renderClass: RenderClass;
} | null {
  if (!mats || Object.keys(mats).length === 0) return null;

  let anyTexture = false;
  let method: string | undefined;
  const faces = {} as Record<Cardinal, FaceAppearance>;
  for (const f of CARDINALS) {
    const mat = materialForFace(mats, f);
    const tex = mat?.texture;
    if (tex) anyTexture = true;
    if (mat?.renderMethod && !method) method = mat.renderMethod;
    faces[f] = {
      texture: tex || NEUTRAL_TEXTURE,
      tint: "none",
      rotation: 0,
    };
  }
  if (!anyTexture) return null;
  return { faces, renderClass: renderClassFromMethod(method) };
}

/**
 * Diagnose palette → atlas coverage for the report script / tests.
 *
 * @param registries - Registries to score.
 * @param atlasHas - Predicate: short-name is packed (not merely known to terrain).
 * @param isFallbackUv - Optional: short-name UV equals `__missing__`.
 * @returns coverage counts + per-entry rows.
 */
export function diagnosePaletteCoverage(
  registries: Registries | null | undefined,
  atlasHas: (shortName: string) => boolean,
  isFallbackUv?: (shortName: string) => boolean,
): PaletteCoverageReport {
  const entries: PaletteEntryCoverage[] = [];
  let withMaterialInstances = 0;
  let texturesResolved = 0;
  let neutralNoMaterials = 0;
  let atlasMiss = 0;
  let withGeometry = 0;

  for (const b of registries?.blocks ?? []) {
    const mats = b.components?.materialInstances;
    const hasMats = !!mats && Object.keys(mats).length > 0;
    const hasGeometry = !!b.components?.geometry || !!b.components?.unitCube;
    if (hasGeometry) withGeometry++;

    const shorts = new Set<string>();
    if (hasMats) {
      withMaterialInstances++;
      for (const m of Object.values(mats!)) {
        if (m?.texture) shorts.add(m.texture);
      }
    }

    const textureShortNames = [...shorts];
    let texturesOk = false;
    let reason: PaletteMissReason | undefined;
    let detail: string | undefined;

    if (!hasMats) {
      neutralNoMaterials++;
      reason = "no_material_instances";
      detail = "meshed as neutral grey cube";
    } else if (textureShortNames.length === 0) {
      neutralNoMaterials++;
      reason = "empty_textures";
      detail = "material_instances present but no texture fields";
    } else {
      const missing = textureShortNames.filter((s) => !atlasHas(s));
      const fallbacked = isFallbackUv
        ? textureShortNames.filter((s) => isFallbackUv(s))
        : [];
      if (missing.length || fallbacked.length) {
        atlasMiss++;
        reason = "atlas_miss";
        detail = [...new Set([...missing, ...fallbacked])].join(",");
      } else {
        texturesOk = true;
        texturesResolved++;
      }
    }

    entries.push({
      name: b.name,
      hasMaterialInstances: hasMats,
      textureShortNames,
      texturesResolved: texturesOk,
      hasGeometry,
      reason,
      detail,
    });
  }

  return {
    entryCount: entries.length,
    withMaterialInstances,
    texturesResolved,
    neutralNoMaterials,
    atlasMiss,
    withGeometry,
    entries,
  };
}

/**
 * @param texture - Resolved face texture id.
 * @returns true for the magenta missing-texture sentinel.
 */
export function isMissingTexture(texture: string): boolean {
  return texture === FALLBACK_TEXTURE;
}
