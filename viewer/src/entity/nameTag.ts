import * as THREE from "three";
import { parseFormatCodes } from "../ui/formatCodes";

/** In-scene name-tag billboard. */
export interface NameTagSprite {
  root: THREE.Sprite;
  setText(text: string): void;
  setVisible(visible: boolean): void;
  /**
   * Billboard toward camera and scale by distance.
   *
   * @param camera - Active camera.
   * @param worldPos - Anchor above the head (world space).
   */
  update(camera: THREE.Camera, worldPos: THREE.Vector3): void;
  dispose(): void;
}

const PLATE_PAD_X = 4;
const PLATE_PAD_Y = 3;
const FONT_PX = 14;
/** Gap above the visual top / head pivot, in blocks. */
const NAME_TAG_MARGIN = 0.25;

const _box = new THREE.Box3();

/**
 * Create a canvas-textured name tag (white §-coloured text on translucent black).
 *
 * ponytail: plain depth-test occlusion (Sprite depthTest=true). Client draws
 * through walls at reduced opacity — upgrade: dual pass / depth-fail dimming.
 *
 * @returns name-tag handle.
 */
export function createNameTag(): NameTagSprite {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext("2d")!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;

  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const root = new THREE.Sprite(mat);
  root.visible = false;
  // Bottom-center at the world anchor so the plate sits above the head.
  root.center.set(0.5, 0);

  let lastText = "";

  return {
    root,
    setText(text: string): void {
      if (text === lastText) return;
      lastText = text;
      paintNameTag(ctx, canvas, texture, text);
      // World size from canvas aspect; ~1 block wide at reference resolution.
      const w = canvas.width / 64;
      const h = canvas.height / 64;
      root.scale.set(w, h, 1);
    },
    setVisible(visible: boolean): void {
      root.visible = visible;
    },
    update(camera: THREE.Camera, worldPos: THREE.Vector3): void {
      root.position.copy(worldPos);
      // Distance attenuation similar to client: shrink beyond ~8 blocks.
      const dist = camera.position.distanceTo(worldPos);
      const atten = Math.min(1, 8 / Math.max(dist, 0.01));
      const baseW = canvas.width / 64;
      const baseH = canvas.height / 64;
      root.scale.set(baseW * atten, baseH * atten, 1);
    },
    dispose(): void {
      mat.dispose();
      texture.dispose();
    },
  };
}

/**
 * Paint §-formatted text onto the canvas with a half-transparent black plate.
 *
 * @param ctx - 2d context.
 * @param canvas - Target canvas (resized).
 * @param texture - THREE texture to invalidate.
 * @param text - Raw name (may include § codes).
 */
function paintNameTag(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  texture: THREE.CanvasTexture,
  text: string,
): void {
  const segments = parseFormatCodes(text);
  const plain = segments.map((s) => s.text).join("");
  if (!plain) {
    canvas.width = 4;
    canvas.height = 4;
    texture.needsUpdate = true;
    return;
  }

  ctx.font = `${FONT_PX}px "Courier New", monospace`;
  const metrics = ctx.measureText(plain);
  const textW = Math.ceil(metrics.width);
  const textH = FONT_PX + 2;
  canvas.width = textW + PLATE_PAD_X * 2;
  canvas.height = textH + PLATE_PAD_Y * 2;

  ctx.font = `${FONT_PX}px "Courier New", monospace`;
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let x = PLATE_PAD_X;
  const y = PLATE_PAD_Y;
  for (const seg of segments) {
    if (!seg.text) continue;
    ctx.fillStyle = seg.color ?? "#ffffff";
    if (seg.bold) ctx.font = `bold ${FONT_PX}px "Courier New", monospace`;
    else ctx.font = `${FONT_PX}px "Courier New", monospace`;
    ctx.fillText(seg.text, x, y);
    x += ctx.measureText(seg.text).width;
  }
  texture.needsUpdate = true;
}

/**
 * World-space anchor above the entity: max of head pivot, rendered AABB top,
 * and snapshot bbox height (all + margin). Feet origin stays on `feet`.
 *
 * @param bones - Model bones (optional).
 * @param visualRoot - Mesh root to measure (model root, or group for wireframe).
 * @param feet - Entity group (feet origin / world x-z).
 * @param bboxH - Snapshot bbox height.
 * @param out - Vector to write.
 * @returns out.
 */
export function nameTagAnchor(
  bones: Map<string, THREE.Group> | null | undefined,
  visualRoot: THREE.Object3D,
  feet: THREE.Object3D,
  bboxH: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  visualRoot.updateMatrixWorld(true);
  _box.setFromObject(visualRoot);
  let topY = feet.position.y + Math.max(bboxH, 0.01) + NAME_TAG_MARGIN;
  if (!_box.isEmpty() && Number.isFinite(_box.max.y)) {
    topY = Math.max(topY, _box.max.y + NAME_TAG_MARGIN);
  }

  const head = bones?.get("head") ?? bones?.get("Head") ?? bones?.get("HEAD");
  if (head) {
    head.getWorldPosition(out);
    out.y = Math.max(out.y + 0.35, topY);
    return out;
  }
  out.set(feet.position.x, topY, feet.position.z);
  return out;
}
