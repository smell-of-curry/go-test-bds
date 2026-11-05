import type { Block } from "../protocol";
import type { CustomBlockTri } from "./customGeometry";
import type { CubeModel, FaceAppearance } from "./types";

type Vec = [number, number, number];
type Rect = [number, number, number, number];
type Bounds = [number, number, number, number, number, number];
type Face = keyof CubeModel["faces"];

/** Built-in models use packed UV sheets rather than six whole texture tiles. */
export interface SpecialBlockTri extends CustomBlockTri {
  textureIndex?: number;
}

function kind(name: string): "lantern" | "endRod" | "lightningRod" | null {
  // Occlusion probes call this for every lighting corner. Ordinary blocks
  // should not allocate a stripped name or run the native-family patterns.
  if (!name.endsWith("_rod") && !name.endsWith("lantern")) return null;
  if (name.includes(":") && !name.startsWith("minecraft:")) return null;
  const bare = name.replace(/^minecraft:/, "");
  if (bare === "end_rod") return "endRod";
  if (
    /^(?:waxed_)?(?:(?:exposed|weathered|oxidized)_)?lightning_rod$/.test(bare)
  )
    return "lightningRod";
  if (
    bare === "lantern" ||
    bare === "soul_lantern" ||
    /^(?:waxed_)?(?:(?:exposed|weathered|oxidized)_)?copper_lantern$/.test(bare)
  )
    return "lantern";
  return null;
}

export function isSpecialBlock(name: string): boolean {
  return kind(name) !== null;
}

function bit(value: unknown): boolean {
  return value === true || value === 1 || value === "true";
}

/** Preserve pack textures while applying the native model's render properties. */
export function specialBlockProperties(
  block: Block,
  model: CubeModel,
): CubeModel {
  const k = kind(block.name);
  if (!k || model.customGeometryKey) return model;
  const powered = k === "lightningRod" && bit(block.states.powered_bit);
  const faces = { ...model.faces };
  if (k === "lightningRod") {
    for (const face of Object.keys(faces) as Face[])
      faces[face] = { ...faces[face], textureIndex: powered ? 1 : 0 };
  }
  return {
    ...model,
    faces,
    renderClass: "cutout",
    ambientOcclusion: false,
    faceDimming: !powered,
    lightEmission:
      k === "endRod"
        ? 14 / 15
        : k === "lantern"
          ? block.name.endsWith("soul_lantern")
            ? 10 / 15
            : 1
          : 0,
  };
}

/** Rotate the up-facing rod around the cell centre into Bedrock facing_direction. */
function orient(p: Vec, facing: number): Vec {
  const [x, y, z] = p.map((v) => v - 8) as Vec;
  const q: Vec =
    facing === 0
      ? [x, -y, -z]
      : facing === 2
        ? [x, z, -y]
        : facing === 3
          ? [x, -z, y]
          : facing === 4
            ? [-y, x, z]
            : facing === 5
              ? [y, -x, z]
              : [x, y, z];
  return q.map((v) => v + 8) as Vec;
}

function corners(b: Bounds, face: Face): Vec[] {
  const [x0, y0, z0, x1, y1, z1] = b;
  switch (face) {
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
  }
}

function normalDir(p: Vec[]): CustomBlockTri["dir"] {
  const a = p[0]!,
    b = p[1]!,
    c = p[2]!;
  const u = b.map((v, i) => v - a[i]!) as Vec;
  const v = c.map((n, i) => n - a[i]!) as Vec;
  const n = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const abs = n.map(Math.abs);
  const axis = abs.indexOf(Math.max(...abs));
  return (axis * 2 + (n[axis]! < 0 ? 1 : 0)) as CustomBlockTri["dir"];
}

/**
 * Native lantern/rod primitives, expressed in sixteenths of a block. Their
 * 16×16 UV layouts match the installed Bedrock terrain sheets; lantern
 * flipbook frames are selected by the terrain atlas before these UVs apply.
 */
export function emitSpecialBlockTris(
  block: Block,
  model: CubeModel,
  wx: number,
  wy: number,
  wz: number,
): SpecialBlockTri[] | null {
  const k = kind(block.name);
  if (!k || model.customGeometryKey) return null;
  const out: SpecialBlockTri[] = [];
  const rawFacing = Number(block.states.facing_direction ?? 1);
  const facing = rawFacing >= 0 && rawFacing <= 5 ? rawFacing : 1;
  const emit = (
    b: Bounds,
    maps: Partial<Record<Face, Rect>>,
    rotateChain = false,
  ): void => {
    for (const face of Object.keys(maps) as Face[]) {
      const rect = maps[face]!;
      const p = corners(b, face).map((p): Vec => {
        if (rotateChain) {
          const x = p[0] - 8,
            z = p[2] - 8;
          p = [(x + z) * Math.SQRT1_2 + 8, p[1], (z - x) * Math.SQRT1_2 + 8];
        }
        if (k !== "lantern") p = orient(p, facing);
        return [wx + p[0] / 16, wy + p[1] / 16, wz + p[2] / 16];
      });
      const [u0, v0, u1, v1] = rect.map((v) => v / 16) as Rect;
      const uv = [
        [u0, 1 - v1],
        [u1, 1 - v1],
        [u1, 1 - v0],
        [u0, 1 - v0],
      ];
      const app: FaceAppearance = model.faces[face];
      for (const indices of [
        [0, 1, 2],
        [0, 2, 3],
      ])
        out.push({
          positions: indices.flatMap((i) => p[i]!),
          uvs: indices.flatMap((i) => uv[i]!),
          texture: app.texture,
          textureIndex: app.textureIndex,
          adjacentLight: true,
          pass: "opaque",
          faceDimming: !rotateChain && model.faceDimming !== false,
          ambientOcclusion: false,
          dir: normalDir(p),
          doubleSided: false,
        });
    }
  };
  const sides = (uv: Rect): Partial<Record<Face, Rect>> => ({
    north: uv,
    south: uv,
    west: uv,
    east: uv,
  });
  if (k === "endRod") {
    emit([6, 0, 6, 10, 1, 10], {
      ...sides([2, 6, 6, 7]),
      down: [6, 6, 2, 2],
      up: [2, 2, 6, 6],
    });
    emit([7, 1, 7, 9, 16, 9], { ...sides([0, 0, 2, 15]), up: [2, 0, 4, 2] });
  } else if (k === "lightningRod") {
    emit([6, 12, 6, 10, 16, 10], {
      ...sides([0, 0, 4, 4]),
      down: [0, 0, 4, 4],
      up: [4, 4, 0, 0],
    });
    emit([7, 0, 7, 9, 12, 9], { ...sides([0, 4, 2, 16]), down: [0, 4, 2, 6] });
  } else {
    const hanging = bit(block.states.hanging);
    const y = hanging ? 1 : 0;
    emit([5, y, 5, 11, 7 + y, 11], {
      ...sides([0, 2, 6, 9]),
      down: [0, 9, 6, 15],
      up: [0, 9, 6, 15],
    });
    emit([6, 7 + y, 6, 10, 9 + y, 10], {
      ...sides([1, 0, 5, 2]),
      up: [1, 10, 5, 14],
    });
    if (hanging) {
      emit(
        [6.5, 11, 8, 9.5, 15, 8],
        { north: [14, 1, 11, 5], south: [11, 1, 14, 5] },
        true,
      );
      emit(
        [8, 10, 6.5, 8, 16, 9.5],
        { west: [14, 6, 11, 12], east: [11, 6, 14, 12] },
        true,
      );
    } else {
      emit(
        [6.5, 9, 8, 9.5, 11, 8],
        { north: [14, 1, 11, 3], south: [11, 1, 14, 3] },
        true,
      );
      emit(
        [8, 9, 6.5, 8, 11, 9.5],
        { west: [14, 10, 11, 12], east: [11, 10, 14, 12] },
        true,
      );
    }
  }
  return out;
}
