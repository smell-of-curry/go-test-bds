/** XYZ triple in Bedrock model units (1 unit = 1/16 block). */
export type Vec3 = readonly [number, number, number];

/** UV pair in texels (or normalised 0–1 for poly_mesh when flagged). */
export type Vec2 = readonly [number, number];

/** Face names on a cube, matching Bedrock's per-face UV keys. */
export type CubeFaceName = "north" | "south" | "east" | "west" | "up" | "down";

/** Per-face UV rectangle from the modern object form. */
export interface FaceUv {
  uv: Vec2;
  uvSize: Vec2;
  /** Optional material instance name for the material layer to resolve later. */
  materialInstance?: string;
  /** Clockwise degrees; only 0 / 90 / 180 / 270 are valid. */
  uvRotation: 0 | 90 | 180 | 270;
}

/** Legacy box unwrap (`uv: [u, v]`) or per-face map. */
export type CubeUv = Vec2 | Partial<Record<CubeFaceName, FaceUv>>;

export interface ParsedCube {
  origin: Vec3;
  size: Vec3;
  rotation: Vec3;
  /** Pivot for cube rotation; falls back to owning bone pivot when omitted. */
  pivot?: Vec3;
  /** When omitted, the owning bone's inflate applies. */
  inflate?: number;
  /** Overrides bone mirror when set. */
  mirror?: boolean;
  uv?: CubeUv;
}

export interface ParsedLocator {
  offset: Vec3;
  rotation: Vec3;
  ignoreInheritedScale: boolean;
}

export interface ParsedPolyMesh {
  positions: Vec3[];
  normals: Vec3[];
  uvs: Vec2[];
  /**
   * Indexed polys: each poly is 3 or 4 verts, each vert is
   * `[positionIndex, normalIndex, uvIndex]`.
   */
  polys: Array<Array<readonly [number, number, number]>>;
  normalizedUvs: boolean;
}

/**
 * Texture-mesh element (texel→voxel). Parsed for completeness; the mesh
 * builder does not expand these — that needs a loaded texture.
 */
export interface ParsedTextureMesh {
  texture: string;
  position: Vec3;
  rotation: Vec3;
  localPivot: Vec3;
  scale: Vec3;
  usePixelDepth: boolean;
}

export interface ParsedBone {
  name: string;
  parent: string | null;
  pivot: Vec3;
  /** Rest-pose Euler degrees `[rx, ry, rz]`, extrinsic XYZ. */
  rotation: Vec3;
  /** Additional rest rotation; applied before {@link rotation} when present. */
  bindPoseRotation?: Vec3;
  mirror: boolean;
  /** Inherited by cubes that omit their own inflate. */
  inflate?: number;
  /** Raw Molang / bone-name binding string; not evaluated here. */
  binding?: string;
  locators: Record<string, ParsedLocator>;
  cubes: ParsedCube[];
  polyMesh?: ParsedPolyMesh;
  textureMeshes: ParsedTextureMesh[];
}

export interface GeometryDescription {
  identifier: string;
  textureWidth: number;
  textureHeight: number;
  /**
   * False when the file omitted texture_width/height (vanilla
   * humanoid.custom does) — the engine then uses the actual texture size,
   * so the mesher must too. Absent/true = declared sizes are authoritative.
   */
  textureSizeExplicit?: boolean;
  visibleBoundsWidth?: number;
  visibleBoundsHeight?: number;
  visibleBoundsOffset?: Vec3;
}

/** One entry from `minecraft:geometry` (or a legacy `geometry.*` value). */
export interface ParsedGeometry {
  description: GeometryDescription;
  bones: ParsedBone[];
  /** Original `format_version` string when present. */
  formatVersion?: string;
}

/** Full `.geo.json` document — may contain multiple geometries. */
export interface GeometryDocument {
  formatVersion?: string;
  geometries: ParsedGeometry[];
}

/**
 * BufferGeometry-compatible arrays for one bone's drawable content.
 * Positions / normals are in three.js block space, authored model space
 * (see README). Pose with that bone's world matrix from the hierarchy.
 */
export interface BoneMeshBuffers {
  boneName: string;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /**
   * Material instance name per face quad (two triangles share one entry).
   * Empty string means the default / unresolved material.
   */
  materialInstances: string[];
  /** Face name per quad when the source was a cube face; `poly` otherwise. */
  faces: Array<CubeFaceName | "poly">;
}
