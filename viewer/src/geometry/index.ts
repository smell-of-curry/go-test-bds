/**
 * Bedrock `.geo.json` parser and mesh builder for the go-test-bds viewer.
 *
 * See {@link ./README.md} for coordinate / rotation conventions and evidence.
 */

export { GeometryParseError } from "./errors";
export {
  buildBoneHierarchy,
  computeBoneWorldMatrices,
  computeBoneWorldMatricesBedrock,
  transformModelPoint,
  type BoneNode,
  type BonePoseOverride,
} from "./bones";
export {
  MODEL_UNITS_PER_BLOCK,
  bedrockMatrixToThree,
  bedrockNormalToThree,
  bedrockToThree,
  boneLocalMatrix,
  rotateAboutPivot,
  rotationMatrixXYZ,
  transformDir,
  transformPoint,
} from "./math";
export { parseGeometryDocument } from "./parse";
export { buildGeometryMeshes } from "./mesh";
export { resolveFaceUv, texelToGl } from "./uv";
export type {
  BoneMeshBuffers,
  CubeFaceName,
  CubeUv,
  FaceUv,
  GeometryDescription,
  GeometryDocument,
  ParsedBone,
  ParsedCube,
  ParsedGeometry,
  ParsedLocator,
  ParsedPolyMesh,
  ParsedTextureMesh,
  Vec2,
  Vec3,
} from "./types";
