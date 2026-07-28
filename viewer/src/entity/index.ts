/**
 * Bedrock entity rendering: client entity defs, render controllers,
 * textured bone hierarchies, and Stage 9 animation / Molang playback.
 *
 * See {@link ./README.md}.
 */

export { parseClientEntity } from "./parseClient";
export { parseRenderControllers } from "./parseController";
export { parseAnimations } from "./parseAnimation";
export type {
  AnimBoneChannels,
  AnimChannel,
  AnimKeyframe,
  ChannelExpr,
  ParsedAnimation,
} from "./parseAnimation";
export { parseAnimControllers } from "./parseAnimController";
export type {
  ControllerAnimRef,
  ControllerState,
  ControllerTransition,
  ParsedAnimController,
} from "./parseAnimController";
export {
  advanceAnimTime,
  applyBonePoses,
  catmullRom,
  emptyBonePose,
  ensureRestMatrix,
  isAnimationFinished,
  resetBonesToRest,
  resolveSampleTime,
  sampleAnimation,
  sampleAnimationPoses,
  sampleChannel,
  type BoneAnimPose,
} from "./animation";
export {
  buildAnimationBindings,
  EntityAnimator,
  remapCurve,
  type AnimEntityState,
  type AnimationBindings,
} from "./controllerRuntime";
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
  isAnimControllerPath,
  isAnimationPath,
  isClientEntityPath,
  isRenderControllerPath,
  type EntityLike,
} from "./registry";
export type {
  ClientEntityDef,
  ClientEntityMaps,
  ClientEntityScripts,
  EntityRenderInputs,
  RenderControllerArrays,
  RenderControllerDef,
  ResolvedControllerPass,
} from "./types";
