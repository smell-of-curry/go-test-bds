/**
 * Round blob shadow under a mob or player. Bedrock draws one per entity
 * (`textures/misc` has no shadow sprite in bedrock-samples — the blob is a
 * generated radial gradient, not a vendored texture). It is projected onto
 * the top faces of blocks below the feet, within 4 blocks, and fades with
 * height. Sized from the collision-box width.
 */

import * as THREE from "three";

/** How far below the feet a surface still receives a shadow. */
export const SHADOW_MAX_DROP = 4;
/** Centre opacity standing on the surface. */
const SHADOW_ALPHA = 0.5;

export interface ShadowQuad {
  /** Block-top world X (integer cell). */
  x: number;
  /** Surface Y (top of the solid cell). */
  y: number;
  /** Block-top world Z. */
  z: number;
  /** 0..1 height fade (1 = feet on the surface). */
  fade: number;
}

/**
 * Quads covering block tops under an entity. Deterministic scan, -X/-Z first.
 *
 * @param feetX - Entity feet X.
 * @param feetY - Entity feet Y.
 * @param feetZ - Entity feet Z.
 * @param width - Collision box width (blocks).
 * @param solid - True when the integer cell has a surface.
 * @returns quads whose UV circle is centred on the feet.
 */
export function shadowQuads(
  feetX: number,
  feetY: number,
  feetZ: number,
  width: number,
  solid: (x: number, y: number, z: number) => boolean,
): ShadowQuad[] {
  const radius = Math.max(0.35, width * 0.55);
  const x0 = Math.floor(feetX - radius);
  const x1 = Math.floor(feetX + radius);
  const z0 = Math.floor(feetZ - radius);
  const z1 = Math.floor(feetZ + radius);
  const startY = Math.floor(feetY - 0.001);
  const out: ShadowQuad[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const cx = x + 0.5;
      const cz = z + 0.5;
      if ((cx - feetX) ** 2 + (cz - feetZ) ** 2 > (radius + 0.72) ** 2) {
        continue;
      }
      let surface: number | null = null;
      for (let dy = 0; dy <= SHADOW_MAX_DROP; dy++) {
        const by = startY - dy;
        if (solid(x, by, z)) {
          surface = by + 1;
          break;
        }
      }
      if (surface == null) continue;
      const drop = feetY - surface;
      if (drop > SHADOW_MAX_DROP || drop < -0.2) continue;
      const fade = 1 - Math.max(0, drop) / SHADOW_MAX_DROP;
      if (fade <= 0.02) continue;
      out.push({ x, y: surface, z, fade });
    }
  }
  return out;
}

/** World radius of the blob for a collision width. */
export function shadowRadius(width: number): number {
  return Math.max(0.35, width * 0.55);
}

const VERT = /* glsl */ `
attribute float fade;
varying vec2 vUv;
varying float vFade;
void main() {
  vUv = uv;
  vFade = fade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
varying float vFade;
void main() {
  float a = texture2D(map, vUv).a * vFade;
  if (a < 0.01) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}
`;

let sharedTex: THREE.CanvasTexture | null = null;
let sharedMat: THREE.ShaderMaterial | null = null;

/**
 * @returns the shared radial blob (deterministic canvas, no RNG).
 */
function shadowTexture(): THREE.CanvasTexture {
  if (sharedTex) return sharedTex;
  const s = 64;
  const canvas = document.createElement("canvas");
  canvas.width = s;
  canvas.height = s;
  const g = canvas.getContext("2d")!;
  const grd = g.createRadialGradient(
    s / 2,
    s / 2,
    s * 0.05,
    s / 2,
    s / 2,
    s / 2,
  );
  grd.addColorStop(0, `rgba(0,0,0,${SHADOW_ALPHA})`);
  grd.addColorStop(0.45, `rgba(0,0,0,${SHADOW_ALPHA * 0.55})`);
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  sharedTex = new THREE.CanvasTexture(canvas);
  sharedTex.magFilter = THREE.LinearFilter;
  sharedTex.minFilter = THREE.LinearFilter;
  sharedTex.wrapS = THREE.ClampToEdgeWrapping;
  sharedTex.wrapT = THREE.ClampToEdgeWrapping;
  sharedTex.colorSpace = THREE.NoColorSpace;
  sharedTex.needsUpdate = true;
  return sharedTex;
}

function shadowMaterial(): THREE.ShaderMaterial {
  if (sharedMat) return sharedMat;
  sharedMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: shadowTexture() } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  return sharedMat;
}

/**
 * One blob, rebuilt when the landing quads change. Shared material.
 */
export class EntityBlobShadow {
  readonly mesh: THREE.Mesh;
  private key = "";

  constructor() {
    const geo = new THREE.BufferGeometry();
    this.mesh = new THREE.Mesh(geo, shadowMaterial());
    this.mesh.name = "entity-shadow";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
  }

  /**
   * @param feetX - Feet X.
   * @param feetY - Feet Y.
   * @param feetZ - Feet Z.
   * @param width - Collision width.
   * @param solid - Surface test.
   */
  update(
    feetX: number,
    feetY: number,
    feetZ: number,
    width: number,
    solid: (x: number, y: number, z: number) => boolean,
  ): void {
    const quads = shadowQuads(feetX, feetY, feetZ, width, solid);
    if (quads.length === 0) {
      this.mesh.visible = false;
      this.key = "";
      return;
    }
    const radius = shadowRadius(width);
    const key = `${quads.length}:${quads[0]!.x},${quads[0]!.y},${quads[0]!.z}:${radius.toFixed(2)}`;
    this.mesh.visible = true;
    if (key === this.key && this.mesh.geometry.getAttribute("position")) {
      return;
    }
    // Fade changes every frame while jumping; include fade in the key.
    const fadeKey = quads.map((q) => q.fade.toFixed(2)).join(",");
    const full = `${key}|${fadeKey}`;
    if (full === this.key) return;
    this.key = full;
    const positions: number[] = [];
    const uvs: number[] = [];
    const fades: number[] = [];
    const indices: number[] = [];
    for (const q of quads) {
      const base = positions.length / 3;
      const corners: Array<[number, number]> = [
        [q.x, q.z + 1],
        [q.x + 1, q.z + 1],
        [q.x + 1, q.z],
        [q.x, q.z],
      ];
      const y = q.y + 0.03;
      for (const [wx, wz] of corners) {
        positions.push(wx, y, wz);
        uvs.push(
          (wx - feetX) / (radius * 2) + 0.5,
          (wz - feetZ) / (radius * 2) + 0.5,
        );
        fades.push(q.fade);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const geo = this.mesh.geometry;
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute("fade", new THREE.Float32BufferAttribute(fades, 1));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
  }

  hide(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.removeFromParent();
  }
}
