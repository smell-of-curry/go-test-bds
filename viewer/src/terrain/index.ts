import type { Mesher } from "../scene";
import { AssetClient } from "./assetClient";
import { buildTerrainAtlas, type TerrainAtlas } from "./atlas";
import type { BiomeAt, CustomGeometryHook } from "./types";
import { BlockModelResolver } from "./resolve";
import { TexturedMesher } from "./mesher";

export { AssetClient } from "./assetClient";
export {
  TerrainAtlas,
  buildTerrainAtlas,
  packRects,
  FALLBACK_TEXTURE,
  makeFallbackBitmap,
} from "./atlas";
export {
  parseBlocksJson,
  parseTerrainTextureJson,
  parseFlipbookJson,
  pickVariationIndex,
  flipbookFrameAt,
  expandTexturesField,
  hashPos,
} from "./parse";
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
  liquidHeight,
} from "./mesher";
export { createTerrainMaterial, wrapTileCoord } from "./material";
export { tintAt, UNTINTED, BIOME_SNAPSHOT_NOTE } from "./biome";
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
  /** Biome lookup; null/omit → untinted. */
  biomeAt?: BiomeAt | null;
  /** Stage-8 custom geometry seam. */
  customGeometry?: CustomGeometryHook | null;
  /**
   * Extra terrain short-names to pack (beyond blocks.json references).
   */
  extraTextures?: Iterable<string>;
}

export interface TexturedMesherBundle {
  mesher: TexturedMesher;
  /** Same object — satisfies scene constructor. */
  asMesher: Mesher;
  atlas: TerrainAtlas;
  resolver: BlockModelResolver;
  client: AssetClient;
}

/**
 * Drop-in entry point for the parent agent:
 *
 * ```ts
 * const { asMesher } = await createTexturedMesher();
 * const scene = new Scene(camera, asMesher);
 * ```
 *
 * Loads `/packs/index`, `blocks.json`, `terrain_texture.json`,
 * `flipbook_textures.json`, and referenced PNGs via `/asset/...`.
 *
 * @param opts - Base URL, biome hook, extras.
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

  const blocksJson = await client.fetchJson("blocks.json");
  if (!blocksJson) {
    throw new Error("blocks.json missing from pack stack");
  }
  const resolver = BlockModelResolver.fromJson(blocksJson);
  const names = resolver.allTextureNames();
  if (opts.extraTextures) {
    for (const n of opts.extraTextures) names.add(n);
  }

  const atlas = await buildTerrainAtlas(client, names);
  const mesher = new TexturedMesher(atlas, resolver, {
    biomeAt: opts.biomeAt ?? null,
    customGeometry: opts.customGeometry ?? null,
  });
  return { mesher, asMesher: mesher, atlas, resolver, client };
}
