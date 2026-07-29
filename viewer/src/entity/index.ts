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
  setBoneLocalPose,
  type BoneAnimPose,
  type BoneRestPose,
} from "./animation";
export {
  addLocomotionPoses,
  classifyLimb,
  createLocomotion,
  tickLocomotion,
  type LimbClass,
  type LocomotionState,
} from "./locomotion";
export {
  buildAnimationBindings,
  EntityAnimator,
  remapCurve,
  type AnimEntityState,
  type AnimationBindings,
} from "./controllerRuntime";
export { createEntityMolangHost } from "./queries";
export {
  expandMaterialRef,
  expandShortRef,
  evaluatePassTint,
  modelCacheKey,
  resolveMaterialName,
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
  applyTintToRoot,
  composeControllerTint,
  createEntityMaterial,
  DEFAULT_ENTITY_MATERIAL,
  evalColor,
  lerpRgba,
  materialStateFromName,
  type MaterialRenderState,
  type Rgba,
  type TransparencyMode,
  WHITE,
} from "./material";
export {
  armourTextureStem,
  looksLikeArmour,
  pickBone,
  selectArmourLayers,
  selectHeldItem,
  type ArmourLayerSpec,
  type ArmourSlot,
  type HeldItemSpec,
} from "./equipment";
export {
  buildItemSprite,
  poseHeldItem,
  tickDroppedItem,
  type ItemSprite,
} from "./itemSprite";
export { ItemIconResolver } from "./itemIcons";
export { createNameTag, nameTagAnchor, type NameTagSprite } from "./nameTag";
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
  RenderControllerColor,
  RenderControllerDef,
  ResolvedControllerPass,
} from "./types";
