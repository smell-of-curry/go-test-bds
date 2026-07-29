import * as THREE from "three";
import { ENTITY_ALPHA_TEST } from "./buildModel";

/** Disposable flat item sprite (held or dropped). */
export interface ItemSprite {
  root: THREE.Group;
  mesh: THREE.Mesh;
  dispose(): void;
}

/**
 * Build a flat alpha-tested textured quad for an item icon.
 *
 * ponytail: single quad, no thickness extrusion. Ceiling: client builds a
 * thin extruded mesh from the sprite silhouette — upgrade path is a voxel
 * extrude of opaque texels.
 *
 * @param texture - Item icon texture.
 * @param size - Quad edge length in blocks.
 * @returns sprite handle.
 */
export function buildItemSprite(
  texture: THREE.Texture,
  size = 0.5,
): ItemSprite {
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const geo = new THREE.PlaneGeometry(size, size);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    alphaTest: ENTITY_ALPHA_TEST,
    transparent: false,
    side: THREE.DoubleSide,
    depthWrite: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const root = new THREE.Group();
  root.name = "itemSprite";
  root.add(mesh);

  return {
    root,
    mesh,
    dispose(): void {
      geo.dispose();
      mat.dispose();
      texture.dispose();
    },
  };
}

/**
 * Dropped-item spin + bob (client-ish). Call each frame.
 *
 * @param root - Sprite root at entity feet / centre.
 * @param lifeSec - Seconds since spawn (or cumulative).
 * @param groundY - Resting Y (entity pos Y).
 */
export function tickDroppedItem(
  root: THREE.Object3D,
  lifeSec: number,
  groundY: number,
): void {
  // ~360° / 3s spin; bob ±0.05 blocks.
  root.rotation.y = lifeSec * ((Math.PI * 2) / 3);
  root.position.y = groundY + 0.15 + Math.sin(lifeSec * 2.5) * 0.05;
}

/**
 * Orient a held-item quad in the hand bone (flat, facing outward).
 *
 * @param root - Sprite root parented to a hand bone.
 */
export function poseHeldItem(root: THREE.Object3D): void {
  // Bone-local: slight offset + tilt so the sprite reads as "in hand".
  root.position.set(0.05, -0.1, -0.1);
  root.rotation.set(0, Math.PI / 2, 0);
  root.scale.setScalar(0.7);
}
