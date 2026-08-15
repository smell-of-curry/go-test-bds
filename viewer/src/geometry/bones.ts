import { Matrix4 } from "three";
import { GeometryParseError } from "./errors";
import { bedrockMatrixToThree, boneLocalMatrix, transformPoint } from "./math";
import type { ParsedBone, ParsedGeometry, Vec3 } from "./types";

/** Pose override for a single bone (degrees / model-unit translation). */
export interface BonePoseOverride {
  /** Replaces rest-pose rotation when set. */
  rotation?: Vec3;
  /** Extra translation in Bedrock model units, applied after rotation about pivot. */
  position?: Vec3;
}

/**
 * Resolved bone with parent/child links for posing.
 */
export interface BoneNode {
  name: string;
  parent: BoneNode | null;
  children: BoneNode[];
  pivot: Vec3;
  rotation: Vec3;
  bindPoseRotation?: Vec3;
  mirror: boolean;
  inflate?: number;
  binding?: string;
  raw: ParsedBone;
}

/**
 * Build a parent-linked bone tree from a parsed geometry.
 *
 * @param geometry - Parsed geometry.
 * @returns Root bones (those with no parent) and a name→node map.
 * @throws {GeometryParseError} on cycles.
 */
export function buildBoneHierarchy(geometry: ParsedGeometry): {
  roots: BoneNode[];
  byName: Map<string, BoneNode>;
} {
  const byName = new Map<string, BoneNode>();
  for (const b of geometry.bones) {
    byName.set(b.name, {
      name: b.name,
      parent: null,
      children: [],
      pivot: b.pivot,
      rotation: b.rotation,
      bindPoseRotation: b.bindPoseRotation,
      mirror: b.mirror,
      inflate: b.inflate,
      binding: b.binding,
      raw: b,
    });
  }

  const roots: BoneNode[] = [];
  for (const b of geometry.bones) {
    const node = byName.get(b.name)!;
    if (b.parent === null) {
      roots.push(node);
      continue;
    }
    const parent = byName.get(b.parent);
    if (!parent) {
      throw new GeometryParseError(
        `bone '${b.name}' parents missing bone '${b.parent}'`,
      );
    }
    node.parent = parent;
    parent.children.push(node);
  }

  detectCycles(byName);
  return { roots, byName };
}

/**
 * Compute each bone's rest-pose (or posed) world matrix in Bedrock model space.
 * World matrix maps absolute model-space points through the rotate-about-pivot
 * chain: `M_root * M_… * M_bone` where `M = T(p)*R*T(-p)`.
 *
 * @param geometry - Parsed geometry.
 * @param pose - Optional per-bone rotation/position overrides.
 * @returns Map of bone name → Bedrock model-space world matrix.
 */
export function computeBoneWorldMatricesBedrock(
  geometry: ParsedGeometry,
  pose?: Record<string, BonePoseOverride>,
): Map<string, Matrix4> {
  const { roots, byName } = buildBoneHierarchy(geometry);
  const out = new Map<string, Matrix4>();

  const visit = (node: BoneNode, parentWorld: Matrix4 | null): void => {
    const override = pose?.[node.name];
    const rotation = override?.rotation ?? node.rotation;
    let local = boneLocalMatrix(node.pivot, rotation, node.bindPoseRotation);
    if (override?.position) {
      const [x, y, z] = override.position;
      local = new Matrix4().makeTranslation(x, y, z).multiply(local);
    }
    const world = parentWorld ? parentWorld.clone().multiply(local) : local;
    out.set(node.name, world);
    for (const child of node.children) visit(child, world);
  };

  for (const root of roots) visit(root, null);

  // Bones listed but unreachable (shouldn't happen after cycle check) still get identity.
  for (const name of byName.keys()) {
    if (!out.has(name)) out.set(name, new Matrix4());
  }
  return out;
}

/**
 * Compute each bone's world matrix in three.js block space.
 *
 * @param geometry - Parsed geometry.
 * @param pose - Optional per-bone overrides.
 * @returns Map of bone name → three.js block-space world matrix.
 */
export function computeBoneWorldMatrices(
  geometry: ParsedGeometry,
  pose?: Record<string, BonePoseOverride>,
): Map<string, Matrix4> {
  const bedrock = computeBoneWorldMatricesBedrock(geometry, pose);
  const out = new Map<string, Matrix4>();
  for (const [name, m] of bedrock) {
    out.set(name, bedrockMatrixToThree(m));
  }
  return out;
}

/**
 * Transform a Bedrock model-space point by a bone's world matrix (Bedrock).
 *
 * @param matrices - From {@link computeBoneWorldMatricesBedrock}.
 * @param boneName - Bone to use.
 * @param point - Model-space point.
 * @returns Transformed model-space point.
 * @throws {GeometryParseError} when the bone is unknown.
 */
export function transformModelPoint(
  matrices: Map<string, Matrix4>,
  boneName: string,
  point: Vec3,
): Vec3 {
  const m = matrices.get(boneName);
  if (!m) {
    throw new GeometryParseError(`unknown bone '${boneName}'`);
  }
  return transformPoint(m, point);
}

/**
 * @param byName - Bone map.
 * @throws {GeometryParseError} if a parent cycle exists.
 */
function detectCycles(byName: Map<string, BoneNode>): void {
  const state = new Map<string, "visiting" | "done">();

  const dfs = (name: string): void => {
    const s = state.get(name);
    if (s === "done") return;
    if (s === "visiting") {
      throw new GeometryParseError(`bone parent cycle involving '${name}'`);
    }
    state.set(name, "visiting");
    const node = byName.get(name);
    if (node?.parent) dfs(node.parent.name);
    state.set(name, "done");
  };

  for (const name of byName.keys()) dfs(name);
}
