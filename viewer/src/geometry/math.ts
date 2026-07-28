import { Euler, Matrix4, Vector3 } from "three";
import type { Vec3 } from "./types";

/** Model units per block — Bedrock geometry is authored at 16 units = 1 block. */
export const MODEL_UNITS_PER_BLOCK = 16;

const DEG2RAD = Math.PI / 180;

/**
 * Build an extrinsic-XYZ Euler rotation matrix (degrees).
 * Equivalent to `R = Rz * Ry * Rx` (X applied to the point first).
 *
 * Evidence: Blockbench exports Bedrock bones with extrinsic XYZ; three.js
 * `Euler` order `'ZYX'` is the matching intrinsic form for the same angles.
 *
 * @param rotation - `[rx, ry, rz]` in degrees.
 * @returns Rotation matrix.
 */
export function rotationMatrixXYZ(rotation: Vec3): Matrix4 {
  const [rx, ry, rz] = rotation;
  return new Matrix4().makeRotationFromEuler(
    new Euler(rx * DEG2RAD, ry * DEG2RAD, rz * DEG2RAD, "ZYX"),
  );
}

/**
 * Affine transform that rotates about `pivot`: `T(p) * R * T(-p)`.
 *
 * @param pivot - Point to rotate about, Bedrock model units.
 * @param rotation - Extrinsic XYZ degrees.
 * @returns Affine matrix in Bedrock model space.
 */
export function rotateAboutPivot(pivot: Vec3, rotation: Vec3): Matrix4 {
  const [px, py, pz] = pivot;
  const t = new Matrix4().makeTranslation(px, py, pz);
  const tInv = new Matrix4().makeTranslation(-px, -py, -pz);
  return t.multiply(rotationMatrixXYZ(rotation)).multiply(tInv);
}

/**
 * Compose one bone's local affine matrix in Bedrock model space:
 * `T(pivot) * R(rotation) * R(bindPose?) * T(-pivot)`.
 * Bind-pose rotation (when present) is applied to the point before `rotation`.
 *
 * @param pivot - Bone pivot.
 * @param rotation - Bone rest rotation degrees.
 * @param bindPoseRotation - Optional bind-pose rotation.
 * @returns Affine matrix `T*R*T^-1` for this bone alone.
 */
export function boneLocalMatrix(
  pivot: Vec3,
  rotation: Vec3,
  bindPoseRotation?: Vec3,
): Matrix4 {
  const [px, py, pz] = pivot;
  const t = new Matrix4().makeTranslation(px, py, pz);
  const tInv = new Matrix4().makeTranslation(-px, -py, -pz);
  let r = rotationMatrixXYZ(rotation);
  if (bindPoseRotation) {
    // Point sees bindPose first, then rotation: R_rot * R_bind
    r = r.multiply(rotationMatrixXYZ(bindPoseRotation));
  }
  return t.multiply(r).multiply(tInv);
}

/**
 * Convert a Bedrock model-space point to three.js block space.
 * Negates X (matches bridge-core/model-viewer) and divides by 16.
 *
 * @param v - Bedrock model-space point.
 * @returns three.js block-space point.
 */
export function bedrockToThree(v: Vec3): Vec3 {
  return [
    -v[0] / MODEL_UNITS_PER_BLOCK,
    v[1] / MODEL_UNITS_PER_BLOCK,
    v[2] / MODEL_UNITS_PER_BLOCK,
  ];
}

/**
 * Convert a Bedrock model-space direction (normal) to three.js.
 * Negates X; no uniform scale (length preserved for unit normals).
 *
 * @param n - Bedrock direction.
 * @returns three.js direction.
 */
export function bedrockNormalToThree(n: Vec3): Vec3 {
  return [-n[0], n[1], n[2]];
}

/**
 * Map a Bedrock model-space affine matrix into three.js block space.
 * `M_three = S * F * M_bedrock * F * S^-1` with `F = diag(-1,1,1)`, `S = 1/16`.
 *
 * @param mBedrock - Affine matrix in Bedrock model units.
 * @returns Affine matrix in three.js block units.
 */
export function bedrockMatrixToThree(mBedrock: Matrix4): Matrix4 {
  const f = new Matrix4().makeScale(-1, 1, 1);
  const s = new Matrix4().makeScale(
    1 / MODEL_UNITS_PER_BLOCK,
    1 / MODEL_UNITS_PER_BLOCK,
    1 / MODEL_UNITS_PER_BLOCK,
  );
  const sInv = new Matrix4().makeScale(
    MODEL_UNITS_PER_BLOCK,
    MODEL_UNITS_PER_BLOCK,
    MODEL_UNITS_PER_BLOCK,
  );
  return s.clone().multiply(f).multiply(mBedrock).multiply(f).multiply(sInv);
}

/**
 * Transform a point by a Matrix4.
 *
 * @param m - Affine matrix.
 * @param v - Point.
 * @returns Transformed point as a plain triple.
 */
export function transformPoint(m: Matrix4, v: Vec3): Vec3 {
  const out = new Vector3(v[0], v[1], v[2]).applyMatrix4(m);
  return [out.x, out.y, out.z];
}

/**
 * Transform a direction by the upper 3×3 of a Matrix4 (no translation).
 *
 * @param m - Affine matrix.
 * @param v - Direction.
 * @returns Transformed direction (not re-normalised).
 */
export function transformDir(m: Matrix4, v: Vec3): Vec3 {
  const out = new Vector3(v[0], v[1], v[2]).transformDirection(m);
  return [out.x, out.y, out.z];
}
