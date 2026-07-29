import * as THREE from "three";
import {
  buildBoneHierarchy,
  buildGeometryMeshes,
  computeBoneWorldMatrices,
  parseGeometryDocument,
  type ParsedGeometry,
} from "../geometry";
import { emptyBonePose, setBoneLocalPose } from "./animation";
import {
  createEntityMaterial,
  DEFAULT_ENTITY_MATERIAL,
  materialStateFromName,
  type MaterialRenderState,
  type Rgba,
  WHITE,
} from "./material";
import type { ResolvedControllerPass } from "./types";

/** Alpha cutout threshold for entity skins (transparent texels discarded). */
export const ENTITY_ALPHA_TEST = DEFAULT_ENTITY_MATERIAL.alphaTest;

/** Disposable handle for a built entity model root. */
export interface BuiltEntityModel {
  /** Root group (bones parented underneath). Position at entity feet. */
  root: THREE.Group;
  /** Bone name → group (for Stage 9 animation / head pitch). */
  bones: Map<string, THREE.Group>;
  /** Uniform model scale (from scripts.scale). */
  scale: number;
  /** Release GPU resources. */
  dispose(): void;
}

export interface BuildEntityModelOptions {
  /** Parsed geometry document entry. */
  geometry: ParsedGeometry;
  /** Decoded skin texture (first layer). */
  texture: THREE.Texture;
  /** Optional extra layers (ignored for now beyond first). */
  extraTextures?: THREE.Texture[];
  /** Part visibility from the render controller. */
  partVisibility?: Map<string, boolean>;
  /** Model scale multiplier. */
  scale?: number;
  /** Material name → render state (defaults to alphatest cutout). */
  materialName?: string;
  /** Optional pre-mapped state (wins over materialName). */
  materialState?: MaterialRenderState;
  /** Composed RC tint. */
  tint?: Rgba;
}

/**
 * Build a textured entity model with a named per-bone {@link THREE.Group}
 * hierarchy. Mesh vertices are stored in bone-local space so Stage 9 can drive
 * bone transforms; rest-pose local matrices match the geometry document.
 *
 * @param opts - Geometry, texture, visibility, scale.
 * @returns built model.
 */
export function buildEntityModel(
  opts: BuildEntityModelOptions,
): BuiltEntityModel {
  const {
    geometry,
    texture,
    partVisibility = new Map(),
    scale = 1,
    tint = WHITE,
  } = opts;

  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const state =
    opts.materialState ??
    (opts.materialName
      ? materialStateFromName(opts.materialName)
      : DEFAULT_ENTITY_MATERIAL);
  const material = createEntityMaterial(texture, state, tint);

  const { roots, byName } = buildBoneHierarchy(geometry);
  const worldMats = computeBoneWorldMatrices(geometry);
  const boneGroups = new Map<string, THREE.Group>();
  const disposables: Array<
    THREE.BufferGeometry | THREE.Material | THREE.Texture
  > = [material, texture];

  for (const [name] of byName) {
    const g = new THREE.Group();
    g.name = name;
    boneGroups.set(name, g);
  }

  // Parent hierarchy + rest-pose local matrices (derived from world mats).
  const inv = new THREE.Matrix4();
  for (const [name, node] of byName) {
    const g = boneGroups.get(name)!;
    const world = worldMats.get(name) ?? new THREE.Matrix4();
    if (node.parent) {
      const parentWorld =
        worldMats.get(node.parent.name) ?? new THREE.Matrix4();
      inv.copy(parentWorld).invert();
      g.matrix.copy(inv.multiply(world));
    } else {
      g.matrix.copy(world);
    }
    g.matrixAutoUpdate = false;
    g.matrixWorldNeedsUpdate = true;
    // Stage 9 animation resets to this bind pose each frame.
    g.userData.restMatrix = g.matrix.clone();
    // Pivot/rest rotation so animation rotates about the pivot (JSON-safe —
    // survives Object3D.clone's JSON round-trip of userData).
    g.userData.bedrockPose = {
      pivot: [...node.pivot],
      rotation: [...node.rotation],
      ...(node.bindPoseRotation
        ? { bindPoseRotation: [...node.bindPoseRotation] }
        : {}),
    };
  }

  for (const root of roots) {
    attachBoneTree(root.name, byName, boneGroups, null);
  }

  const defaultVisible = partVisibility.has("*")
    ? partVisibility.get("*")!
    : true;

  // Files that omit texture_width/height resolve UVs against the real skin
  // size (vanilla humanoid.custom + a 64×64 skin).
  const img = texture.image as { width?: number; height?: number } | undefined;
  const meshes = buildGeometryMeshes(
    geometry,
    img && typeof img.width === "number" && typeof img.height === "number"
      ? { width: img.width, height: img.height }
      : undefined,
  );
  const scratch = new THREE.Vector3();
  for (const boneMesh of meshes) {
    const boneGroup = boneGroups.get(boneMesh.boneName);
    if (!boneGroup) continue;

    const visible = partVisibility.has(boneMesh.boneName)
      ? partVisibility.get(boneMesh.boneName)!
      : defaultVisible;
    if (!visible) continue;

    const world = worldMats.get(boneMesh.boneName) ?? new THREE.Matrix4();
    inv.copy(world).invert();

    const positions = new Float32Array(boneMesh.positions.length);
    const normals = new Float32Array(boneMesh.normals.length);
    for (let i = 0; i < boneMesh.positions.length; i += 3) {
      scratch.set(
        boneMesh.positions[i]!,
        boneMesh.positions[i + 1]!,
        boneMesh.positions[i + 2]!,
      );
      scratch.applyMatrix4(inv);
      positions[i] = scratch.x;
      positions[i + 1] = scratch.y;
      positions[i + 2] = scratch.z;

      scratch.set(
        boneMesh.normals[i]!,
        boneMesh.normals[i + 1]!,
        boneMesh.normals[i + 2]!,
      );
      scratch.transformDirection(inv);
      normals[i] = scratch.x;
      normals[i + 1] = scratch.y;
      normals[i + 2] = scratch.z;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(boneMesh.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(boneMesh.indices, 1));
    disposables.push(geo);

    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `mesh:${boneMesh.boneName}`;
    mesh.frustumCulled = false;
    boneGroup.add(mesh);
  }

  const root = new THREE.Group();
  root.name = "entityModel";
  root.scale.setScalar(scale);
  for (const r of roots) {
    const g = boneGroups.get(r.name);
    if (g) root.add(g);
  }

  return {
    root,
    bones: boneGroups,
    scale,
    dispose(): void {
      for (const d of disposables) d.dispose();
    },
  };
}

/**
 * Parent bone groups according to the parsed hierarchy.
 *
 * @param name - Bone name.
 * @param byName - Hierarchy map.
 * @param groups - THREE groups.
 * @param parentName - Parent bone name, or null for roots.
 */
function attachBoneTree(
  name: string,
  byName: ReturnType<typeof buildBoneHierarchy>["byName"],
  groups: Map<string, THREE.Group>,
  parentName: string | null,
): void {
  const node = byName.get(name);
  const g = groups.get(name);
  if (!node || !g) return;
  if (parentName) {
    const parent = groups.get(parentName);
    if (parent && g.parent !== parent) parent.add(g);
  }
  for (const child of node.children) {
    attachBoneTree(child.name, byName, groups, name);
  }
}

/**
 * Parse a geometry JSON document and return the entry matching `identifier`,
 * or the first entry.
 *
 * @param json - Parsed `.geo.json`.
 * @param identifier - `geometry.*` id.
 * @returns parsed geometry or null.
 */
export function geometryById(
  json: unknown,
  identifier: string,
): ParsedGeometry | null {
  try {
    const doc = parseGeometryDocument(json);
    const hit = doc.geometries.find(
      (g) => g.description.identifier === identifier,
    );
    return hit ?? doc.geometries[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Apply Bedrock body yaw (degrees) onto a model root.
 * Matches {@link applyActorEye}: yaw 0 faces +Z (south).
 *
 * @param root - Model root group.
 * @param yawDeg - Bedrock yaw degrees (`rot[0]`).
 */
export function applyEntityYaw(root: THREE.Object3D, yawDeg: number): void {
  root.rotation.order = "YXZ";
  root.rotation.y = Math.PI - THREE.MathUtils.degToRad(yawDeg);
  root.rotation.x = 0;
  root.rotation.z = 0;
}

/**
 * Apply Bedrock pitch to a head bone when present (positive = look down).
 * Rotates about the head bone's pivot (see {@link setBoneLocalPose}).
 *
 * @param bones - Bone map from {@link buildEntityModel}.
 * @param pitchDeg - Bedrock pitch degrees (`rot[1]`).
 */
export function applyHeadPitch(
  bones: Map<string, THREE.Group>,
  pitchDeg: number,
): void {
  const head = bones.get("head") ?? bones.get("Head");
  if (!head) return;
  setBoneLocalPose(head, emptyBonePose(), pitchDeg);
}

/**
 * Convenience: build from a resolved controller pass + loaded assets.
 *
 * @param geometry - Parsed geometry.
 * @param texture - Skin texture.
 * @param pass - Resolved pass (visibility).
 * @param scale - Model scale.
 * @returns built model.
 */
export function buildFromPass(
  geometry: ParsedGeometry,
  texture: THREE.Texture,
  pass: ResolvedControllerPass,
  scale = 1,
): BuiltEntityModel {
  return buildEntityModel({
    geometry,
    texture,
    partVisibility: pass.partVisibility,
    scale,
    materialName: pass.materialName,
    tint: pass.tint,
  });
}
