import type { Mesher } from "../scene";
import type { Registries } from "../protocol";
import { AssetClient } from "./assetClient";
import {
  buildTerrainAtlas,
  FALLBACK_TEXTURE,
  type TerrainAtlas,
} from "./atlas";
import type { BiomeAt, CustomGeometryHook } from "./types";
import {
  mergeBlocksLayers,
  mergeFlipbookLayers,
  mergeTerrainLayers,
} from "./merge";
import { BlockModelResolver } from "./resolve";
import { TexturedMesher } from "./mesher";
import {
  diagnosePaletteCoverage,
  textureNamesFromRegistries,
  type PaletteCoverageReport,
} from "./palette";

export { AssetClient, parsePackJson, normalizePath } from "./assetClient";
export {
  TerrainAtlas,
  buildTerrainAtlas,
  packRects,
  FALLBACK_TEXTURE,
  NEUTRAL_TEXTURE,
  makeFallbackBitmap,
  makeNeutralBitmap,
} from "./atlas";
export {
  parseBlocksJson,
  canonicalizeBlockId,
  parseTerrainTextureJson,
  parseFlipbookJson,
  pickVariationIndex,
  flipbookFrameAt,
  expandTexturesField,
  hashPos,
  normalizeTexPath,
  stripExt,
} from "./parse";
export {
  mergeBlockDef,
  mergeBlocksLayers,
  mergeTerrainLayers,
  mergeFlipbookLayers,
} from "./merge";
export {
  BlockModelResolver,
  isAir,
  isWaterlogFluid,
  facingToFrontFace,
  liquidFlowYaw,
  rotateYFaces,
} from "./resolve";
export {
  TexturedMesher,
  greedyMerge,
  neighbourBlock,
  neighbourLight,
  liquidHeight,
} from "./mesher";
export { createTerrainMaterial, wrapTileCoord } from "./material";
export {
  tintAt,
  UNTINTED,
  normalizeBiomeId,
  biomeIdAt,
  biomeAtFromState,
} from "./biome";
export {
  lightBrightness,
  combinedLight,
  aoFactor,
  FACE_SHADE,
  encodeSectionLight,
} from "./light";
export { decodeTga, bitmapFromTga } from "./tga";
export {
  indexRegistryBlocks,
  textureNamesFromRegistries,
  materialForFace,
  renderClassFromMethod,
  facesFromMaterialInstances,
  diagnosePaletteCoverage,
} from "./palette";
export type {
  PaletteCoverageReport,
  PaletteEntryCoverage,
  PaletteMissReason,
} from "./palette";
export type {
  BiomeAt,
  CubeModel,
  LiquidModel,
  TerrainSection,
  PackInfo,
  CustomGeometryHook,
  FaceAppearance,
  RenderClass,
} from "./types";

export interface CreateTexturedMesherOptions {
  /** Viewer HTTP origin. Defaults to `window.location.origin`. */
  baseUrl?: string;
  /** Biome lookup; null/omit → column wire biomes / untinted. */
  biomeAt?: BiomeAt | null;
  /** Smooth lighting + AO (default true). */
  smoothLighting?: boolean;
  /** Stage-8 custom geometry seam. */
  customGeometry?: CustomGeometryHook | null;
  /**
   * Extra terrain short-names to pack (beyond blocks.json references).
   */
  extraTextures?: Iterable<string>;
  /**
   * Join-static network palette from keyframe `registries`.
   * Optional — omit at boot; call {@link TexturedMesherBundle.applyRegistries}
   * when the keyframe arrives so custom-block tiles enter the atlas.
   */
  registries?: Registries | null;
}

export interface TexturedMesherBundle {
  mesher: TexturedMesher;
  /** Same object — satisfies scene constructor. */
  asMesher: Mesher;
  atlas: TerrainAtlas;
  resolver: BlockModelResolver;
  client: AssetClient;
  /**
   * Bind/replace network palette and rebuild the atlas so new short-names pack.
   * Existing call sites that never pass registries stay valid (no-op-capable).
   *
   * The rebuilt atlas has a different tile layout, so callers MUST remesh every
   * already-meshed section afterwards (e.g. `scene.remeshAll()`) — stale meshes
   * keep UV rects baked against the old layout and render the wrong tiles.
   *
   * @param registries - Keyframe registries or null.
   */
  applyRegistries(registries: Registries | null): Promise<void>;
}

/**
 * Drop-in entry point for the parent agent:
 *
 * ```ts
 * const bundle = await createTexturedMesher();
 * const scene = new Scene(camera, bundle.asMesher);
 * // after keyframe:
 * await bundle.applyRegistries(store.getState().registries);
 * ```
 *
 * Merges `blocks.json` / `terrain_texture.json` / flipbooks across the pack
 * stack via `GET /pack/<id>/...` (not the winner-only `/asset` path). A server
 * pack that only lists `sound` must not erase vanilla `textures`.
 *
 * @param opts - Base URL, biome hook, extras, optional registries.
 * @returns mesher + supporting objects.
 */
export async function createTexturedMesher(
  opts: CreateTexturedMesherOptions = {},
): Promise<TexturedMesherBundle> {
  const baseUrl =
    opts.baseUrl ??
    (typeof window !== "undefined" ? window.location.origin : "");
  if (!baseUrl) {
    throw new Error("createTexturedMesher: baseUrl required outside browser");
  }
  const client = new AssetClient(baseUrl);
  await client.getIndex();

  const blockLayers = await client.fetchJsonLayers("blocks.json");
  if (blockLayers.length === 0) {
    throw new Error("blocks.json missing from every pack in the stack");
  }
  const blocksMerged = mergeBlocksLayers(blockLayers);
  const resolver = new BlockModelResolver(
    blocksMerged,
    opts.registries ?? null,
  );

  const terrainMerged = mergeTerrainLayers(
    await client.fetchJsonLayers("textures/terrain_texture.json"),
  );
  const flipbooksMerged = mergeFlipbookLayers(
    await client.fetchJsonLayers("textures/flipbook_textures.json"),
  );

  const names = resolver.allTextureNames();
  if (opts.extraTextures) {
    for (const n of opts.extraTextures) names.add(n);
  }
  for (const n of textureNamesFromRegistries(opts.registries ?? null)) {
    names.add(n);
  }

  const atlas = await buildTerrainAtlas(client, names, {
    terrain: terrainMerged,
    flipbooks: flipbooksMerged,
  });
  const mesher = new TexturedMesher(atlas, resolver, {
    biomeAt: opts.biomeAt ?? null,
    customGeometry: opts.customGeometry ?? null,
    smoothLighting: opts.smoothLighting,
  });

  const bundle: TexturedMesherBundle = {
    mesher,
    asMesher: mesher,
    atlas,
    resolver,
    client,
    async applyRegistries(registries: Registries | null): Promise<void> {
      resolver.setRegistries(registries);
      const nextNames = resolver.allTextureNames();
      if (opts.extraTextures) {
        for (const n of opts.extraTextures) nextNames.add(n);
      }
      const nextAtlas = await buildTerrainAtlas(client, nextNames, {
        terrain: terrainMerged,
        flipbooks: flipbooksMerged,
      });
      bundle.atlas = nextAtlas;
      mesher.replaceAtlas(nextAtlas);
    },
  };
  return bundle;
}

/**
 * Convenience for the diagnose script: palette coverage against a live atlas.
 *
 * @param registries - Registries to score.
 * @param atlas - Built terrain atlas.
 * @returns coverage report.
 */
export function paletteCoverageAgainstAtlas(
  registries: Registries | null | undefined,
  atlas: TerrainAtlas,
): PaletteCoverageReport {
  const fb = atlas.uvRect(FALLBACK_TEXTURE, 0);
  return diagnosePaletteCoverage(
    registries,
    (s) => atlas.has(s),
    (s) => {
      if (!atlas.has(s)) return true;
      const uv = atlas.uvFor(s, 0, 0, 0, 0);
      return uv.u0 === fb.u0 && uv.v0 === fb.v0 && s !== FALLBACK_TEXTURE;
    },
  );
}
