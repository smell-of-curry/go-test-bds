import * as THREE from "three";

/** Transparency / blend mode for particle materials. */
export type ParticleTransparency = "alpha_test" | "blend" | "add";

export interface ParticleMaterialState {
  transparency: ParticleTransparency;
  alphaTest: number;
}

/**
 * Map Bedrock particle material names → three.js render state.
 * Mirrors the entity material substring table, scoped to `particles_*`.
 *
 * @param name - e.g. `particles_alpha`, `particles_blend`, `particles_add`.
 * @returns render state.
 */
export function particleMaterialState(name: string): ParticleMaterialState {
  const key = name.trim().toLowerCase();
  if (key.includes("add")) {
    return { transparency: "add", alphaTest: 0 };
  }
  if (key.includes("blend")) {
    return { transparency: "blend", alphaTest: 0 };
  }
  return { transparency: "alpha_test", alphaTest: 0.5 };
}

/**
 * Build a PointsMaterial from particle material + optional texture.
 *
 * @param name - Bedrock material id.
 * @param map - Optional texture.
 * @returns configured material.
 */
export function createParticlePointsMaterial(
  name: string,
  map: THREE.Texture | null = null,
): THREE.PointsMaterial {
  const state = particleMaterialState(name);
  const mat = new THREE.PointsMaterial({
    size: 0.15,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    sizeAttenuation: true,
  });
  if (map) {
    mat.map = map;
    mat.alphaMap = map;
  }
  if (state.transparency === "alpha_test") {
    mat.alphaTest = state.alphaTest;
    mat.opacity = 1;
  } else if (state.transparency === "add") {
    mat.blending = THREE.AdditiveBlending;
    mat.opacity = 1;
  } else {
    mat.opacity = 1;
  }
  return mat;
}
