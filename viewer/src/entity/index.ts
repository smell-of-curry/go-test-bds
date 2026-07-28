/**
 * Bedrock entity rendering: client entity defs, render controllers, and
 * textured bone hierarchies.
 *
 * See {@link ./README.md}.
 */

export { parseClientEntity } from "./parseClient";
export { parseRenderControllers } from "./parseController";
export { createEntityMolangHost } from "./queries";
export {
  expandShortRef,
  modelCacheKey,
  resolveOnePass,
  resolveRenderPasses,
  resolveResourceExpr,
  selectControllers,
} from "./resolve";
export {
  applyEntityYaw,
  applyHeadPitch,
  buildEntityModel,
  buildFromPass,
  ENTITY_ALPHA_TEST,
  geometryById,
  type BuiltEntityModel,
  type BuildEntityModelOptions,
} from "./buildModel";
export {
  EntityModelRegistry,
  geometryPathCandidates,
  isClientEntityPath,
  isRenderControllerPath,
  type EntityLike,
} from "./registry";
export type {
  ClientEntityDef,
  ClientEntityMaps,
  EntityRenderInputs,
  RenderControllerArrays,
  RenderControllerDef,
  ResolvedControllerPass,
} from "./types";
