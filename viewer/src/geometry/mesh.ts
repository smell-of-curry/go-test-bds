import {
  bedrockNormalToThree,
  bedrockToThree,
  rotateAboutPivot,
  transformDir,
  transformPoint,
} from "./math";
import type {
  BoneMeshBuffers,
  CubeFaceName,
  ParsedBone,
  ParsedCube,
  ParsedGeometry,
  ParsedPolyMesh,
  Vec3,
} from "./types";
import { resolveFaceUv } from "./uv";

const FACE_NAMES: CubeFaceName[] = [
  "east",
  "west",
  "up",
  "down",
  "north",
  "south",
];

/**
 * Face corners in Bedrock model space for a cube from (x0,y0,z0) to (x1,y1,z1).
 * Order is CCW when viewed from outside (outward normals, right-hand rule).
 *
 * @param face - Face name.
 * @param x0 - Min x.
 * @param y0 - Min y.
 * @param z0 - Min z.
 * @param x1 - Max x.
 * @param y1 - Max y.
 * @param z1 - Max z.
 * @returns Four corners.
 */
function faceVerts(
  face: CubeFaceName,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): [Vec3, Vec3, Vec3, Vec3] {
  switch (face) {
    case "east":
      return [
        [x1, y0, z1],
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
      ];
    case "west":
      return [
        [x0, y0, z0],
        [x0, y0, z1],
        [x0, y1, z1],
        [x0, y1, z0],
      ];
    case "up":
      return [
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
        [x0, y1, z0],
      ];
    case "down":
      return [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
      ];
    case "north":
      return [
        [x1, y0, z0],
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
      ];
    case "south":
      return [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ];
  }
}

const FACE_NORMAL: Record<CubeFaceName, Vec3> = {
  east: [1, 0, 0],
  west: [-1, 0, 0],
  up: [0, 1, 0],
  down: [0, -1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
};

interface MutableMesh {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  materialInstances: string[];
  faces: Array<CubeFaceName | "poly">;
}

/**
 * Build per-bone BufferGeometry-compatible arrays for one parsed geometry.
 *
 * Positions are in **authored model space** (three.js block units) — the
 * numbers written in the `.geo.json` after Bedrock→three conversion. Multiply
 * by {@link computeBoneWorldMatrices} for that bone to apply the pivot/rotation
 * chain and get the posed vertex. `texture_meshes` are not expanded.
 *
 * @param geometry - Parsed geometry.
 * @returns One buffer set per bone that contributed any triangles.
 */
export function buildGeometryMeshes(
  geometry: ParsedGeometry,
): BoneMeshBuffers[] {
  const meshes = new Map<string, MutableMesh>();
  const ensure = (name: string): MutableMesh => {
    let m = meshes.get(name);
    if (!m) {
      m = {
        positions: [],
        normals: [],
        uvs: [],
        indices: [],
        materialInstances: [],
        faces: [],
      };
      meshes.set(name, m);
    }
    return m;
  };

  const tw = geometry.description.textureWidth;
  const th = geometry.description.textureHeight;

  for (const bone of geometry.bones) {
    for (const cube of bone.cubes) {
      appendCube(
        ensure(bone.name),
        cube,
        bone,
        tw,
        th,
        cube.inflate ?? bone.inflate ?? 0,
        cube.mirror ?? bone.mirror,
      );
    }
    if (bone.polyMesh) {
      appendPolyMesh(ensure(bone.name), bone.polyMesh, tw, th);
    }
  }

  const out: BoneMeshBuffers[] = [];
  for (const [boneName, m] of meshes) {
    if (m.indices.length === 0) continue;
    out.push({
      boneName,
      positions: new Float32Array(m.positions),
      normals: new Float32Array(m.normals),
      uvs: new Float32Array(m.uvs),
      indices: new Uint32Array(m.indices),
      materialInstances: m.materialInstances,
      faces: m.faces,
    });
  }
  return out;
}

/**
 * Emit one cube into a bone mesh.
 *
 * @param mesh - Target buffers.
 * @param cube - Cube.
 * @param bone - Owning bone (for default pivot).
 * @param tw - Texture width.
 * @param th - Texture height.
 * @param inflate - Effective inflate.
 * @param mirror - Effective mirror.
 */
function appendCube(
  mesh: MutableMesh,
  cube: ParsedCube,
  bone: ParsedBone,
  tw: number,
  th: number,
  inflate: number,
  mirror: boolean,
): void {
  const [ox, oy, oz] = cube.origin;
  const [sw, sh, sd] = cube.size;
  const x0 = ox - inflate;
  const y0 = oy - inflate;
  const z0 = oz - inflate;
  const x1 = ox + sw + inflate;
  const y1 = oy + sh + inflate;
  const z1 = oz + sd + inflate;
  const sizeWithInflate: [number, number, number] = [
    sw + inflate * 2,
    sh + inflate * 2,
    sd + inflate * 2,
  ];

  const hasCubeRot =
    cube.rotation[0] !== 0 || cube.rotation[1] !== 0 || cube.rotation[2] !== 0;
  const cubePivot = cube.pivot ?? bone.pivot;
  const cubeMatrix = hasCubeRot
    ? rotateAboutPivot(cubePivot, cube.rotation)
    : null;

  for (const face of FACE_NAMES) {
    const uv = resolveFaceUv(face, cube.uv, sizeWithInflate, tw, th, mirror);
    if (uv === null) continue;

    let verts = faceVerts(face, x0, y0, z0, x1, y1, z1);
    let normal: Vec3 = FACE_NORMAL[face];
    // Start with outward CCW indices; flip when an odd number of reflections apply.
    let flipWinding = false;

    if (mirror) {
      const cx = (x0 + x1) / 2;
      verts = [
        [2 * cx - verts[0][0], verts[0][1], verts[0][2]],
        [2 * cx - verts[1][0], verts[1][1], verts[1][2]],
        [2 * cx - verts[2][0], verts[2][1], verts[2][2]],
        [2 * cx - verts[3][0], verts[3][1], verts[3][2]],
      ];
      normal = [-normal[0], normal[1], normal[2]];
      flipWinding = !flipWinding;
    }

    if (cubeMatrix) {
      verts = [
        transformPoint(cubeMatrix, verts[0]),
        transformPoint(cubeMatrix, verts[1]),
        transformPoint(cubeMatrix, verts[2]),
        transformPoint(cubeMatrix, verts[3]),
      ];
      normal = transformDir(cubeMatrix, normal);
    }

    // Bedrock → three.js negates X (odd reflection) → flip winding once more.
    flipWinding = !flipWinding;

    const base = mesh.positions.length / 3;
    const order = flipWinding ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];

    for (let i = 0; i < 4; i++) {
      const model = verts[i]!;
      const localThree = bedrockToThree(model);
      const nThree = bedrockNormalToThree(normal);
      mesh.positions.push(localThree[0], localThree[1], localThree[2]);
      mesh.normals.push(nThree[0], nThree[1], nThree[2]);
      const [u, v] = uv.corners[i]!;
      mesh.uvs.push(u, v);
    }

    for (const idx of order) mesh.indices.push(base + idx);
    mesh.materialInstances.push(uv.materialInstance);
    mesh.faces.push(face);
  }
}

/**
 * Emit a poly_mesh into a bone mesh.
 *
 * @param mesh - Target buffers.
 * @param poly - Parsed poly mesh.
 * @param tw - Texture width.
 * @param th - Texture height.
 */
function appendPolyMesh(
  mesh: MutableMesh,
  poly: ParsedPolyMesh,
  tw: number,
  th: number,
): void {
  for (const face of poly.polys) {
    const base = mesh.positions.length / 3;
    for (const [pi, ni, ui] of face) {
      const pos = poly.positions[pi];
      const nor = poly.normals[ni] ?? [0, 1, 0];
      const uv = poly.uvs[ui] ?? [0, 0];
      if (!pos) continue;

      const localThree = bedrockToThree(pos);
      const nThree = bedrockNormalToThree(nor);
      mesh.positions.push(localThree[0], localThree[1], localThree[2]);
      mesh.normals.push(nThree[0], nThree[1], nThree[2]);

      if (poly.normalizedUvs) {
        mesh.uvs.push(uv[0], 1 - uv[1]);
      } else {
        mesh.uvs.push(uv[0] / (tw || 1), 1 - uv[1] / (th || 1));
      }
    }

    // X-negate flips winding.
    if (face.length === 3) {
      mesh.indices.push(base, base + 2, base + 1);
    } else if (face.length >= 4) {
      mesh.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    mesh.materialInstances.push("");
    mesh.faces.push("poly");
  }
}
