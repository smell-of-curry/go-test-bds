import * as THREE from "three";
import type { Block } from "../protocol";
import type { BlockEntityWire } from "../protocol";

/** Vanilla block ids drawn with dedicated (non-atlas-cube) geometry. */
const CHEST_NAMES = new Set([
  "minecraft:chest",
  "minecraft:trapped_chest",
  "minecraft:ender_chest",
]);
const SIGN_RE = /^(minecraft:)?(.*_)?sign$/;
const BANNER_RE = /banner$/;
const BED_RE = /_bed$/;
const SKULL_RE = /(skull|head)$/;

export type BlockEntityKind = "chest" | "sign" | "banner" | "bed" | "skull";

/**
 * @param name - Block name.
 * @returns dedicated-geometry kind, or null for normal meshing.
 */
export function blockEntityKind(name: string): BlockEntityKind | null {
  if (CHEST_NAMES.has(name)) return "chest";
  if (SIGN_RE.test(name) || name.includes("_sign")) return "sign";
  if (BANNER_RE.test(name) || name.includes("banner")) return "banner";
  if (BED_RE.test(name) || name.endsWith("_bed")) return "bed";
  if (SKULL_RE.test(name) || name.includes("skull") || name.includes("_head"))
    return "skull";
  return null;
}

/**
 * Build dedicated meshes for one block-entity cell.
 *
 * ponytail: banner patterns / bed legs / skull types are a flat textured box
 * (no pattern compositing). Upgrade: composite banner layers from NBT Patterns
 * and per-skull geometry variants from bedrock-samples entity models.
 *
 * @param block - Palette block at the cell.
 * @param be - Optional wire NBT projection (sign text).
 * @param wx - World X.
 * @param wy - World Y.
 * @param wz - World Z.
 * @returns meshes with own materials (caller disposes).
 */
export function meshBlockEntity(
  block: Block,
  be: BlockEntityWire | undefined,
  wx: number,
  wy: number,
  wz: number,
): THREE.Mesh[] {
  const kind = blockEntityKind(block.name);
  if (!kind) return [];

  const yaw = facingYaw(block);
  switch (kind) {
    case "chest":
      return [boxMesh(wx, wy, wz, 14 / 16, 14 / 16, 14 / 16, 0x8b5a2b, yaw)];
    case "sign":
      return signMeshes(block, be, wx, wy, wz, yaw);
    case "banner":
      return [boxMesh(wx, wy, wz, 2 / 16, 1, 12 / 16, 0xc0c0c0, yaw)];
    case "bed":
      return [boxMesh(wx, wy, wz, 1, 6 / 16, 1, 0xb22222, yaw)];
    case "skull":
      return [boxMesh(wx, wy, wz, 8 / 16, 8 / 16, 8 / 16, 0xf5f5dc, yaw)];
  }
}

function signMeshes(
  block: Block,
  be: BlockEntityWire | undefined,
  wx: number,
  wy: number,
  wz: number,
  yaw: number,
): THREE.Mesh[] {
  const wall = block.name.includes("wall_sign");
  const out: THREE.Mesh[] = [];
  // Board.
  const board = boxMesh(
    wx,
    wy + (wall ? 0.35 : 0.55),
    wz,
    1,
    8 / 16,
    1 / 16,
    0xc2a36b,
    yaw,
  );
  out.push(board);
  if (!wall) {
    // Post under a standing sign.
    out.push(boxMesh(wx, wy, wz, 2 / 16, 0.55, 2 / 16, 0x8b6914, yaw));
  }
  const lines = be?.textFront ?? [];
  if (lines.length && typeof document !== "undefined") {
    const tex = textCanvasTexture(lines);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const geo = new THREE.PlaneGeometry(14 / 16, 7 / 16);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(wx + 0.5, wy + (wall ? 0.35 : 0.55) + 0.25, wz + 0.5);
    mesh.rotation.y = yaw;
    // Nudge off the board so it doesn't z-fight.
    mesh.translateZ(0.04);
    mesh.userData.pass = "transparent";
    out.push(mesh);
  }
  return out;
}

/**
 * Axis-aligned box centred in the block, optionally yawed about Y.
 *
 * @param wx - Block X.
 * @param wy - Block Y.
 * @param wz - Block Z.
 * @param sx - Size X in blocks.
 * @param sy - Size Y.
 * @param sz - Size Z.
 * @param color - Hex colour.
 * @param yaw - Radians.
 * @returns mesh.
 */
function boxMesh(
  wx: number,
  wy: number,
  wz: number,
  sx: number,
  sy: number,
  sz: number,
  color: number,
  yaw: number,
): THREE.Mesh {
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  const mat = new THREE.MeshBasicMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(wx + 0.5, wy + sy / 2, wz + 0.5);
  mesh.rotation.y = yaw;
  mesh.userData.pass = "opaque";
  return mesh;
}

function facingYaw(block: Block): number {
  const f = String(
    block.states.facing_direction ??
      block.states.facing ??
      block.states.direction ??
      "",
  );
  switch (f) {
    case "north":
    case "2":
      return Math.PI;
    case "south":
    case "3":
      return 0;
    case "west":
    case "4":
      return Math.PI / 2;
    case "east":
    case "5":
      return -Math.PI / 2;
    default:
      return 0;
  }
}

/**
 * Strip § format codes; draw lines onto a small canvas texture.
 *
 * @param lines - Sign lines.
 * @returns canvas texture.
 */
export function textCanvasTexture(lines: string[]): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 128, 64);
  ctx.fillStyle = "#000000";
  ctx.font = "12px monospace";
  ctx.textAlign = "center";
  const cleaned = lines.map(stripFormatCodes).slice(0, 4);
  for (let i = 0; i < cleaned.length; i++) {
    ctx.fillText(cleaned[i]!, 64, 14 + i * 14);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

/**
 * @param s - Bedrock formatted string.
 * @returns plain text.
 */
export function stripFormatCodes(s: string): string {
  return s.replace(/§./g, "");
}

/**
 * Index wire block entities by world block pos key `"x,y,z"`.
 *
 * @param list - Column blockEntities.
 * @returns map.
 */
export function indexBlockEntities(
  list: BlockEntityWire[] | undefined,
): Map<string, BlockEntityWire> {
  const out = new Map<string, BlockEntityWire>();
  if (!list) return out;
  for (const be of list) {
    out.set(`${be.pos[0]},${be.pos[1]},${be.pos[2]}`, be);
  }
  return out;
}
