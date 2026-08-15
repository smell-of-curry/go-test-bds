export { parseParticleEffect, sampleTintGradient } from "./parse";
export { evaluateCurve, applyCurves } from "./curves";
export { parseExpr, evalExpr, sanitizeMolangSource } from "./expr";
export {
  ParticleSystem,
  MAX_LIVE_PARTICLES,
  type ParticleSystemOptions,
  type ParticleDebugHandle,
} from "./runtime";
export { ParticleRegistry } from "./registry";
export {
  particleMaterialState,
  createParticlePointsMaterial,
} from "./material";
export type {
  ParsedParticleEffect,
  ParticleCurve,
  MolangExpr,
  TintColor,
} from "./types";
