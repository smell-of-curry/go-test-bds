import type { Block, RegistryMaterial, RegistryTransform } from "../protocol";
import type { DecodedSection } from "../store";

/** Face names used in blocks.json / meshing. */
export type FaceName =
  "up" | "down" | "north" | "south" | "east" | "west" | "side";

/** Pack stack entry from GET /packs. */
export interface PackInfo {
  id: string;
  uuid: string;
  version: string;
  name: string;
  priority: number;
  fileCount: number;
}

/** Winning-pack index from GET /packs/index. */
export type PackIndex = Record<string, string>;

/**
 * Section with optional layer-1 (waterlogging) data.
 * Store decode does not yet populate these — duck-typed until that lands.
 */
export type TerrainSection = DecodedSection & {
  indices1?: Uint16Array;
  palette1?: Block[];
};

/** How a block contributes to face culling / draw passes. */
export type RenderClass =
  "air" | "opaque" | "cutout" | "translucent" | "liquid";

/** One atlas tile placement (pixel space). */
export interface AtlasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Resolved texture short-name → atlas UV rect (normalised 0..1). */
export interface AtlasUv {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Pixel rect inside the atlas (for flipbook sub-frames). */
  px: AtlasRect;
}

/** Per-face appearance after state resolution. */
export interface FaceAppearance {
  /** Terrain texture short-name (atlas key), or fallback sentinel. */
  texture: string;
  /** Optional biome tint channel. */
  tint: "none" | "grass" | "foliage" | "water";
  /** UV rotation in 90° steps (0..3), applied in mesher. */
  rotation: 0 | 1 | 2 | 3;
}

/** Cube model: one appearance per cardinal face. */
export interface CubeModel {
  faces: Record<
    "up" | "down" | "north" | "south" | "east" | "west",
    FaceAppearance
  >;
  renderClass: RenderClass;
  /**
   * When set and {@link BlockGeometryCache} has the id, mesher emits that
   * geometry instead of the unit cube (still carries faces for atlas / fallback).
   */
  customGeometryKey?: string;
  transformation?: RegistryTransform;
  lightEmission?: number;
  /** material_instances face_dimming (default true). */
  faceDimming?: boolean;
  /** material_instances ambient_occlusion (default true). */
  ambientOcclusion?: boolean;
  boneVisibility?: Record<string, unknown>;
  materialInstances?: Record<string, RegistryMaterial>;
}

/** Liquid surface model (layer 0 liquid or layer-1 waterlogging). */
export interface LiquidModel {
  textureStill: string;
  textureFlow: string;
  tint: "none" | "water";
  /** 0 = source/full, 1..7 = flowing level (Bedrock liquid_depth). */
  depth: number;
  /** Flow heading in degrees on XZ, or null for still/source. */
  flowYaw: number | null;
  renderClass: "liquid";
}

/**
 * Biome lookup. Column wire biomes feed this via `biomeAtFromState`;
 * return null to skip tint (untinted white).
 *
 * @param x - Block X.
 * @param z - Block Z.
 * @returns biome identifier (e.g. `minecraft:plains`) or null.
 */
export type BiomeAt = (x: number, z: number) => string | null;

/** RGB multiplier applied to a tinted face. */
export interface TintRgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Optional custom-geometry hook (stage 8). Return true if the cell was handled.
 */
export interface CustomGeometryHook {
  /**
   * @param block - Block at the cell.
   * @param wx - World X.
   * @param wy - World Y.
   * @param wz - World Z.
   * @returns true when custom geometry was emitted and the cube path should skip.
   */
  tryMesh(block: Block, wx: number, wy: number, wz: number): boolean;
}

/** Weighted terrain_texture variation entry. */
export interface TerrainVariation {
  path: string;
  weight: number;
}

/** One terrain_texture.json texture_data entry (resolved). */
export interface TerrainTextureEntry {
  /** Single path, or weighted variations. */
  paths: TerrainVariation[];
}

/** Flipbook entry from flipbook_textures.json. */
export interface FlipbookEntry {
  /** Source texture path (pack-relative, no extension). */
  flipbookTexture: string;
  /** Atlas / terrain short-name this animates. */
  atlasTile: string;
  ticksPerFrame: number;
  /** Explicit frame indices; null = sequential 0..n-1 from image height. */
  frames: number[] | null;
  blendFrames: boolean;
}

/** blocks.json textures field shapes. */
export type BlockTexturesField =
  | string
  | {
      up?: string;
      down?: string;
      side?: string;
      north?: string;
      south?: string;
      east?: string;
      west?: string;
    };

export interface BlockDef {
  textures?: BlockTexturesField;
  carried_textures?: BlockTexturesField;
  /** Sound / isotropic / etc. ignored for meshing. */
  [key: string]: unknown;
}
