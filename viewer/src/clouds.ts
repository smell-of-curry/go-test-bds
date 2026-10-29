/**
 * Bedrock fancy (volumetric) clouds.
 *
 * Matches the client pass that extrudes `textures/environment/clouds.png`
 * (vanilla baseline, 256×256, opaque texel = one cell):
 *
 * - Cell footprint **12×12** blocks, extrusion **4** blocks. Same grid Java's
 *   `LevelRenderer` / `CloudRenderer` has used since the fancy-cloud rewrite;
 *   Bedrock's fancy setting draws that same bank (chunky sides in the
 *   reference frames, not a flat sheet).
 * - Overworld deck at **Y = 192** (raised with the 1.18 world height; this
 *   viewer targets baseline 1.26.50). Nether/end leave the deck off — caller
 *   only mounts it for the overworld sky.
 * - Drift **+X at 0.03 blocks/tick** (0.6 blocks/s). The classic scroll term
 *   is added on X; the bank translates +X. Deterministic in `nowMs` — no RNG.
 * - Face shade (top / ±Z / ±X / bottom) = 1.0 / 0.9 / 0.8 / 0.7, alpha 0.8.
 * - Distance fade toward the horizon fog colour (gentle; the scene fog far
 *   is the chunk radius and would otherwise erase a Y=192 deck).
 */

import * as THREE from "three";

/** Blocks per cloud texel. */
export const CLOUD_CELL = 12;
/** Extruded height in blocks. */
export const CLOUD_THICKNESS = 4;
/** Overworld cloud deck base Y. */
export const CLOUD_Y = 192;
/** Blocks per tick along +X (Bedrock/Java fancy scroll). */
export const CLOUD_BLOCKS_PER_TICK = 0.03;
/** Ticks per second the render clock is calibrated to. */
export const CLOUD_TICKS_PER_SEC = 20;
/** Top / ±Z / ±X / bottom multipliers on white. */
export const CLOUD_SHADE_TOP = 1;
export const CLOUD_SHADE_Z = 0.9;
export const CLOUD_SHADE_X = 0.8;
export const CLOUD_SHADE_BOTTOM = 0.7;
/** Overall cloud alpha (sky shows through slightly). */
export const CLOUD_ALPHA = 0.8;

const CELL_RADIUS = 16;

/**
 * +X drift in blocks for a render-clock sample.
 *
 * @param nowMs - Virtualized `performance.now()` (film mode fakes this).
 * @returns blocks to translate the bank along +X. `0` when `nowMs` is 0.
 */
export function cloudDriftBlocks(nowMs: number): number {
  if (!Number.isFinite(nowMs) || nowMs <= 0) return 0;
  return (nowMs / 1000) * CLOUD_BLOCKS_PER_TICK * CLOUD_TICKS_PER_SEC;
}

/**
 * @param n - Integer (may be negative).
 * @param m - Positive modulus.
 * @returns wrapped index in `[0, m)`.
 */
function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/**
 * Decode an RGBA cloud texture. Opaque texels are cells.
 *
 * @param rgba - Tight RGBA bytes, row 0 = image top.
 * @param width - Texture width.
 * @param height - Texture height.
 * @returns 0/1 mask, row-major, length width*height.
 */
export function cloudMaskFromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = (rgba[i * 4 + 3] ?? 0) > 128 ? 1 : 0;
  }
  return mask;
}

interface CloudGeo {
  positions: number[];
  colors: number[];
  indices: number[];
}

/**
 * Build one camera-centred cloud bank in pattern space (drift is a later
 * group translation). Faces between two solid cells are culled. Order is
 * cell-then-face, so the mesh is a pure function of the inputs.
 *
 * @param mask - Row-major 0/1 from {@link cloudMaskFromRgba}.
 * @param width - Mask width (texture).
 * @param height - Mask height.
 * @param camX - Camera world X.
 * @param camZ - Camera world Z.
 * @param drift - Current +X drift in blocks (window recentres in pattern space).
 * @returns geometry, or null when the mask is empty.
 */
export function buildCloudGeometry(
  mask: Uint8Array,
  width: number,
  height: number,
  camX: number,
  camZ: number,
  drift: number,
): THREE.BufferGeometry | null {
  if (width <= 0 || height <= 0 || mask.length < width * height) return null;
  const sampleX = camX - drift;
  const cx0 = Math.floor(sampleX / CLOUD_CELL) - CELL_RADIUS;
  const cx1 = Math.floor(sampleX / CLOUD_CELL) + CELL_RADIUS;
  const cz0 = Math.floor(camZ / CLOUD_CELL) - CELL_RADIUS;
  const cz1 = Math.floor(camZ / CLOUD_CELL) + CELL_RADIUS;

  const solid = (cellX: number, cellZ: number): boolean => {
    const tx = mod(cellX, width);
    const tz = mod(cellZ, height);
    return mask[tz * width + tx] === 1;
  };

  const acc: CloudGeo = { positions: [], colors: [], indices: [] };
  const y0 = CLOUD_Y;
  const y1 = CLOUD_Y + CLOUD_THICKNESS;

  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      if (!solid(cx, cz)) continue;
      const x0 = cx * CLOUD_CELL;
      const x1 = x0 + CLOUD_CELL;
      const z0 = cz * CLOUD_CELL;
      const z1 = z0 + CLOUD_CELL;
      // +Y top
      pushFace(acc, CLOUD_SHADE_TOP, [
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
        [x0, y1, z0],
      ]);
      // -Y bottom
      pushFace(acc, CLOUD_SHADE_BOTTOM, [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
      ]);
      if (!solid(cx + 1, cz)) {
        pushFace(acc, CLOUD_SHADE_X, [
          [x1, y0, z1],
          [x1, y0, z0],
          [x1, y1, z0],
          [x1, y1, z1],
        ]);
      }
      if (!solid(cx - 1, cz)) {
        pushFace(acc, CLOUD_SHADE_X, [
          [x0, y0, z0],
          [x0, y0, z1],
          [x0, y1, z1],
          [x0, y1, z0],
        ]);
      }
      if (!solid(cx, cz + 1)) {
        pushFace(acc, CLOUD_SHADE_Z, [
          [x0, y0, z1],
          [x1, y0, z1],
          [x1, y1, z1],
          [x0, y1, z1],
        ]);
      }
      if (!solid(cx, cz - 1)) {
        pushFace(acc, CLOUD_SHADE_Z, [
          [x1, y0, z0],
          [x0, y0, z0],
          [x0, y1, z0],
          [x1, y1, z0],
        ]);
      }
    }
  }

  if (acc.positions.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(acc.positions, 3),
  );
  geo.setAttribute("color", new THREE.Float32BufferAttribute(acc.colors, 3));
  geo.setIndex(acc.indices);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * @param acc - Vertex sink.
 * @param shade - RGB multiplier.
 * @param corners - Four CCW corners.
 */
function pushFace(
  acc: CloudGeo,
  shade: number,
  corners: Array<[number, number, number]>,
): void {
  const base = acc.positions.length / 3;
  for (const [x, y, z] of corners) {
    acc.positions.push(x, y, z);
    acc.colors.push(shade, shade, shade);
  }
  acc.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

const CLOUD_VERT = /* glsl */ `
varying vec3 vColor;
varying float vFogDepth;
void main() {
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const CLOUD_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vFogDepth;
uniform vec3 uFogColor;
uniform float uAlpha;
void main() {
  float fogFactor = smoothstep(96.0, 320.0, vFogDepth);
  vec3 rgb = mix(vColor, uFogColor, fogFactor * 0.85);
  gl_FragColor = vec4(rgb, uAlpha);
  #include <colorspace_fragment>
}
`;

/**
 * Fancy-cloud bank. Loads the pack texture once, rebuilds when the camera
 * or the drift crosses a cell, slides +X between rebuilds.
 */
export class CloudField {
  readonly root = new THREE.Group();
  private mask: Uint8Array | null = null;
  private texW = 0;
  private texH = 0;
  private mesh: THREE.Mesh | null = null;
  private readonly material: THREE.ShaderMaterial;
  private builtKey = "";
  /** True once the texture fetch settled (hit or miss). */
  ready = false;

  constructor() {
    this.root.name = "clouds";
    this.root.frustumCulled = false;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uFogColor: { value: new THREE.Color(0xa9d2fb) },
        uAlpha: { value: CLOUD_ALPHA },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      vertexColors: true,
      transparent: true,
      depthWrite: true,
      fog: false,
      side: THREE.FrontSide,
    });
  }

  /**
   * Fetch and decode `clouds.png`. Safe to call once.
   *
   * @param url - Absolute or same-origin URL of the winning pack texture.
   */
  async load(url: string): Promise<void> {
    try {
      const img = await loadImage(url);
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const rgba = ctx.getImageData(0, 0, img.width, img.height).data;
      this.mask = cloudMaskFromRgba(rgba, img.width, img.height);
      this.texW = img.width;
      this.texH = img.height;
      this.builtKey = "";
    } catch {
      this.mask = null;
    } finally {
      this.ready = true;
    }
  }

  /**
   * Slide or rebuild the bank.
   *
   * @param camX - Camera world X.
   * @param camZ - Camera world Z.
   * @param nowMs - Render clock. `0` freezes the bank (absent world time).
   * @param fogHex - Horizon fog colour `0xRRGGBB`.
   */
  update(camX: number, camZ: number, nowMs: number, fogHex: number): void {
    const fog = this.material.uniforms.uFogColor!.value as THREE.Color;
    fog.setHex(fogHex);
    if (!this.mask) return;
    const drift = cloudDriftBlocks(nowMs);
    this.root.position.x = drift;
    const cellX = Math.floor((camX - drift) / CLOUD_CELL);
    const cellZ = Math.floor(camZ / CLOUD_CELL);
    const key = `${cellX},${cellZ}`;
    if (key === this.builtKey && this.mesh) return;
    const geo = buildCloudGeometry(
      this.mask,
      this.texW,
      this.texH,
      camX,
      camZ,
      drift,
    );
    this.builtKey = key;
    if (this.mesh) {
      this.mesh.geometry.dispose();
      if (geo) this.mesh.geometry = geo;
      else {
        this.root.remove(this.mesh);
        this.mesh = null;
      }
      return;
    }
    if (!geo) return;
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = "cloud-bank";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.root.add(this.mesh);
  }

  dispose(): void {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.material.dispose();
    this.root.removeFromParent();
    this.mask = null;
  }
}

/**
 * @param url - Image URL.
 * @returns decoded HTML image.
 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`cloud texture ${url}`));
    img.src = url;
  });
}
