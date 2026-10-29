/**
 * Bedrock/Java entity diffuse. Entities are not block-lit face-by-face.
 * The client shader (`minecraft_mix_light` in the entity program) dots the
 * world normal against two fixed lights and floors the result:
 *
 *   L0 = normalize(0.2, 1.0, -0.7)
 *   L1 = normalize(-0.2, 1.0, 0.7)
 *   shade = min(1, (max(0, dot(N, L0)) + max(0, dot(N, L1))) * 0.6 + 0.4)
 *
 * Axis-aligned boxes then read approximately:
 *   up 1.0, ±Z ~0.74, ±X ~0.50, down 0.4.
 * The +0.4 term is the ambient floor (bottoms stay visible). World light
 * (sky/block at the entity, brightness curve from `terrain/light.ts`)
 * multiplies after shade. Emissive materials skip this file entirely.
 *
 * ponytail: normals are transformed by `mat3(modelMatrix)` then normalized.
 * Non-uniform bone scale skews them. Upgrade: inverse-transpose, which needs
 * a GLSL 3 shader (`inverse` is not in the WebGL1 ShaderMaterial path).
 */

import * as THREE from "three";

/** Subset of {@link MaterialRenderState} — kept local to avoid a cycle. */
interface LitState {
  transparency: "opaque" | "alpha_test" | "blend";
  cull: boolean;
  alphaTest: number;
}

interface LitTint {
  r: number;
  g: number;
  b: number;
  a: number;
}

const L0_RAW: readonly [number, number, number] = [0.2, 1, -0.7];
const L1_RAW: readonly [number, number, number] = [-0.2, 1, 0.7];

function normalize3(
  v: readonly [number, number, number],
): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

const L0 = normalize3(L0_RAW);
const L1 = normalize3(L1_RAW);

/**
 * Entity face shade for a world-space normal. Same formula as the shader.
 *
 * @param nx - World normal X.
 * @param ny - World normal Y.
 * @param nz - World normal Z.
 * @returns multiplier in 0.4..1.
 */
export function entityShade(nx: number, ny: number, nz: number): number {
  const len = Math.hypot(nx, ny, nz) || 1;
  const x = nx / len;
  const y = ny / len;
  const z = nz / len;
  const d0 = Math.max(0, x * L0[0] + y * L0[1] + z * L0[2]);
  const d1 = Math.max(0, x * L1[0] + y * L1[1] + z * L1[2]);
  return Math.min(1, (d0 + d1) * 0.6 + 0.4);
}

const VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldNormal;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  #include <begin_vertex>
  #include <project_vertex>
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform sampler2D map;
uniform vec3 uTint;
uniform float uOpacity;
uniform float uLight;
uniform float uAlphaTest;
varying vec2 vUv;
varying vec3 vWorldNormal;
#include <fog_pars_fragment>
void main() {
  vec4 tex = texture2D(map, vUv);
  if (uAlphaTest > 0.0 && tex.a < uAlphaTest) discard;
  vec3 n = normalize(vWorldNormal);
  vec3 L0 = normalize(vec3(0.2, 1.0, -0.7));
  vec3 L1 = normalize(vec3(-0.2, 1.0, 0.7));
  float d0 = max(0.0, dot(n, L0));
  float d1 = max(0.0, dot(n, L1));
  float shade = min(1.0, (d0 + d1) * 0.6 + 0.4);
  vec3 rgb = tex.rgb * uTint * shade * uLight;
  float a = tex.a * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(rgb, a);
  #include <fog_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Lit entity material. `uLight` is the world-light brightness (1 = noon sky).
 * Caller clones the material per instance before writing `uLight`.
 *
 * @param texture - Skin. sRGB upload; the shader decodes via the GPU format.
 * @param state - Mapped Bedrock material (non-emissive).
 * @param tint - RC tint, linear 0–1.
 * @returns shader material with face shade × world light.
 */
export function createLitEntityMaterial(
  texture: THREE.Texture,
  state: LitState,
  tint: LitTint,
): THREE.ShaderMaterial {
  const blend = state.transparency === "blend";
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      uTint: { value: new THREE.Color(tint.r, tint.g, tint.b) },
      uOpacity: { value: tint.a },
      uLight: { value: 1 },
      uAlphaTest: {
        value: state.transparency === "alpha_test" ? state.alphaTest : 0,
      },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: blend || tint.a < 1,
    depthWrite: !blend,
    side: state.cull ? THREE.FrontSide : THREE.DoubleSide,
    // Custom shader has no THREE fog uniforms. fog:true throws in
    // refreshFogUniforms once the scene has fog (film and live).
    fog: false,
  });
  mat.userData.emissive = false;
  mat.userData.materialState = state;
  return mat;
}

/**
 * Write world-light brightness onto every lit material under a model.
 * Emissive `MeshBasicMaterial`s have no `uLight` and stay fullbright.
 *
 * @param root - Model root.
 * @param brightness - 0..1 from the brightness curve.
 */
export function setEntityLight(root: THREE.Object3D, brightness: number): void {
  const b = Math.min(1, Math.max(0, brightness));
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const u = (m as THREE.ShaderMaterial).uniforms?.uLight;
      if (u) u.value = b;
    }
  });
}

/**
 * @param material - Entity material.
 * @param tint - Composed RGBA.
 * @returns true when the material consumed the tint.
 */
export function applyTintToLitMaterial(
  material: THREE.Material,
  tint: LitTint,
): boolean {
  const u = (material as THREE.ShaderMaterial).uniforms;
  if (!u?.uTint || !u.uOpacity) return false;
  (u.uTint.value as THREE.Color).setRGB(tint.r, tint.g, tint.b);
  u.uOpacity.value = tint.a;
  if (tint.a < 1) material.transparent = true;
  return true;
}
