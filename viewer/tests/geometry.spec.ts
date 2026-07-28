import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bedrockToThree,
  buildGeometryMeshes,
  computeBoneWorldMatrices,
  computeBoneWorldMatricesBedrock,
  GeometryParseError,
  parseGeometryDocument,
  transformModelPoint,
  transformPoint,
} from "../src/geometry/index";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "geometry");

/**
 * @param name - Fixture file name under fixtures/geometry.
 * @returns Parsed JSON.
 */
function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

test.describe("geometry parser", () => {
  test("parses a single-cube modern document", () => {
    const doc = parseGeometryDocument(loadFixture("single_cube.geo.json"));
    expect(doc.geometries).toHaveLength(1);
    const geo = doc.geometries[0]!;
    expect(geo.description.identifier).toBe("geometry.test.single_cube");
    expect(geo.description.textureWidth).toBe(16);
    expect(geo.bones).toHaveLength(1);
    expect(geo.bones[0]!.cubes).toHaveLength(1);
    expect(geo.bones[0]!.cubes[0]!.size).toEqual([16, 16, 16]);
  });

  test("parses legacy geometry.<name> keyed form", () => {
    const doc = parseGeometryDocument(loadFixture("legacy_keyed.geo.json"));
    expect(doc.geometries).toHaveLength(1);
    const geo = doc.geometries[0]!;
    expect(geo.description.identifier).toBe("geometry.test.legacy");
    expect(geo.description.textureWidth).toBe(64);
    expect(geo.description.textureHeight).toBe(32);
    expect(geo.bones[0]!.cubes[0]!.origin).toEqual([-8, 0, -8]);
  });

  test("parses poly_mesh, locators, per-face UV and mirror", () => {
    const poly = parseGeometryDocument(loadFixture("poly_mesh.geo.json"));
    expect(poly.geometries[0]!.bones[0]!.polyMesh?.polys).toHaveLength(1);

    const nested = parseGeometryDocument(loadFixture("nested_bones.geo.json"));
    expect(nested.geometries[0]!.bones[1]!.locators.tip?.offset).toEqual([
      32, 16, 16,
    ]);

    const uv = parseGeometryDocument(loadFixture("per_face_uv.geo.json"));
    const cubeUv = uv.geometries[0]!.bones[0]!.cubes[0]!.uv;
    expect(
      cubeUv && !Array.isArray(cubeUv) && cubeUv.north?.materialInstance,
    ).toBe("mat_north");

    const mir = parseGeometryDocument(loadFixture("mirrored_cube.geo.json"));
    expect(mir.geometries[0]!.bones[0]!.cubes[0]!.mirror).toBe(true);
  });

  test("throws a clear error on malformed geometry", () => {
    expect(() => parseGeometryDocument(null)).toThrow(GeometryParseError);
    expect(() => parseGeometryDocument({})).toThrow(
      /neither minecraft:geometry/,
    );
    expect(() =>
      parseGeometryDocument({
        format_version: "1.21.0",
        "minecraft:geometry": [{ bones: [] }],
      }),
    ).toThrow(/description/);
    expect(() =>
      parseGeometryDocument({
        format_version: "1.21.0",
        "minecraft:geometry": [
          {
            description: { identifier: "geometry.bad" },
            bones: [{ name: "child", parent: "missing" }],
          },
        ],
      }),
    ).toThrow(/missing bone 'missing'/);
  });
});

test.describe("bone hierarchy and nested rotations", () => {
  test("hand-computed world position of a known vertex through two rotations", () => {
    // Fixture: root Ry(90°) about origin, arm Rx(90°) about (16,0,0),
    // cube origin (16,0,0) size 16³. Known vertex = cube max corner (32,16,16).
    //
    // Arm: (32,16,16) - (16,0,0) = (16,16,16)
    //      Rx(90): (16, -16, 16) + pivot = (32, -16, 16)
    // Root: Ry(90): (16, -16, -32)
    // three.js: (-1, -1, -2)
    const doc = parseGeometryDocument(loadFixture("nested_bones.geo.json"));
    const geo = doc.geometries[0]!;
    const bedrockMats = computeBoneWorldMatricesBedrock(geo);
    const worldBedrock = transformModelPoint(bedrockMats, "arm", [32, 16, 16]);
    expect(worldBedrock[0]).toBeCloseTo(16, 5);
    expect(worldBedrock[1]).toBeCloseTo(-16, 5);
    expect(worldBedrock[2]).toBeCloseTo(-32, 5);

    const expectedThree = bedrockToThree([16, -16, -32]);
    expect(expectedThree).toEqual([-1, -1, -2]);

    const threeMats = computeBoneWorldMatrices(geo);
    const meshes = buildGeometryMeshes(geo);
    const armMesh = meshes.find((m) => m.boneName === "arm");
    expect(armMesh).toBeTruthy();

    // Every authored corner must land on the hand-computed world position of
    // that same corner after boneWorld * local. Check the max corner.
    const armMat = threeMats.get("arm")!;
    let found = false;
    for (let i = 0; i < armMesh!.positions.length; i += 3) {
      const local: [number, number, number] = [
        armMesh!.positions[i]!,
        armMesh!.positions[i + 1]!,
        armMesh!.positions[i + 2]!,
      ];
      const world = transformPoint(armMat, local);
      if (
        Math.abs(world[0] - expectedThree[0]) < 1e-5 &&
        Math.abs(world[1] - expectedThree[1]) < 1e-5 &&
        Math.abs(world[2] - expectedThree[2]) < 1e-5
      ) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});

test.describe("mesh builder", () => {
  test("single cube emits 24 vertices / 12 triangles", () => {
    const geo = parseGeometryDocument(loadFixture("single_cube.geo.json"))
      .geometries[0]!;
    const meshes = buildGeometryMeshes(geo);
    expect(meshes).toHaveLength(1);
    const m = meshes[0]!;
    expect(m.positions.length / 3).toBe(24);
    expect(m.indices.length / 3).toBe(12);
    expect(m.faces).toHaveLength(6);
  });

  test("inflate expands extents by inflate on each side", () => {
    const plain = buildGeometryMeshes(
      parseGeometryDocument(loadFixture("single_cube.geo.json")).geometries[0]!,
    )[0]!;
    const inflated = buildGeometryMeshes(
      parseGeometryDocument(loadFixture("inflate.geo.json")).geometries[0]!,
    )[0]!;

    const extent = (mesh: typeof plain, axis: 0 | 1 | 2) => {
      let min = Infinity;
      let max = -Infinity;
      for (let i = axis; i < mesh.positions.length; i += 3) {
        const v = mesh.positions[i]!;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      return { min, max, span: max - min };
    };

    // Plain: 16 model units = 1 block on Y/Z; X is negated so span still 1.
    expect(extent(plain, 1).span).toBeCloseTo(1, 5);
    // Inflate 1 → 18 model units = 18/16 blocks.
    expect(extent(inflated, 1).span).toBeCloseTo(18 / 16, 5);
    expect(extent(inflated, 1).min).toBeCloseTo(-1 / 16, 5);
  });

  test("mirrored cube keeps outward-facing winding", () => {
    const geo = parseGeometryDocument(loadFixture("mirrored_cube.geo.json"))
      .geometries[0]!;
    const mesh = buildGeometryMeshes(geo)[0]!;
    const mats = computeBoneWorldMatrices(geo);
    const world = mats.get("body")!;

    for (let t = 0; t < mesh.indices.length; t += 3) {
      const i0 = mesh.indices[t]!;
      const i1 = mesh.indices[t + 1]!;
      const i2 = mesh.indices[t + 2]!;
      const a = transformPoint(world, [
        mesh.positions[i0 * 3]!,
        mesh.positions[i0 * 3 + 1]!,
        mesh.positions[i0 * 3 + 2]!,
      ]);
      const b = transformPoint(world, [
        mesh.positions[i1 * 3]!,
        mesh.positions[i1 * 3 + 1]!,
        mesh.positions[i1 * 3 + 2]!,
      ]);
      const c = transformPoint(world, [
        mesh.positions[i2 * 3]!,
        mesh.positions[i2 * 3 + 1]!,
        mesh.positions[i2 * 3 + 2]!,
      ]);
      const e1: [number, number, number] = [
        b[0] - a[0],
        b[1] - a[1],
        b[2] - a[2],
      ];
      const e2: [number, number, number] = [
        c[0] - a[0],
        c[1] - a[1],
        c[2] - a[2],
      ];
      const nx = e1[1] * e2[2] - e1[2] * e2[1];
      const ny = e1[2] * e2[0] - e1[0] * e2[2];
      const nz = e1[0] * e2[1] - e1[1] * e2[0];
      const cx = (a[0] + b[0] + c[0]) / 3;
      const cy = (a[1] + b[1] + c[1]) / 3;
      const cz = (a[2] + b[2] + c[2]) / 3;
      // Cube centre in three.js for origin 0 size 16: (-0.5, 0.5, 0.5)
      const ox = cx - -0.5;
      const oy = cy - 0.5;
      const oz = cz - 0.5;
      // Outward ⇒ geometric normal · (centroid - centre) > 0
      expect(nx * ox + ny * oy + nz * oz).toBeGreaterThan(0);
    }
  });

  test("per-face UV on non-square texture normalises correctly", () => {
    const geo = parseGeometryDocument(loadFixture("per_face_uv.geo.json"))
      .geometries[0]!;
    const mesh = buildGeometryMeshes(geo)[0]!;
    const northIdx = mesh.faces.indexOf("north");
    expect(northIdx).toBeGreaterThanOrEqual(0);
    // North face verts are indices northIdx*4 .. +3
    const base = northIdx * 4;
    const uvs: number[][] = [];
    for (let i = 0; i < 4; i++) {
      uvs.push([mesh.uvs[(base + i) * 2]!, mesh.uvs[(base + i) * 2 + 1]!]);
    }
    // uv [0,0] uv_size [16,32] on 32×64 → U 0..0.5, V from 1 down to 0.5
    const us = uvs.map((p) => p[0]!);
    const vs = uvs.map((p) => p[1]!);
    expect(Math.min(...us)).toBeCloseTo(0, 5);
    expect(Math.max(...us)).toBeCloseTo(16 / 32, 5);
    expect(Math.min(...vs)).toBeCloseTo(1 - 32 / 64, 5);
    expect(Math.max(...vs)).toBeCloseTo(1, 5);
    expect(mesh.materialInstances[northIdx]).toBe("mat_north");
  });

  test("poly_mesh emits one quad (two tris)", () => {
    const geo = parseGeometryDocument(loadFixture("poly_mesh.geo.json"))
      .geometries[0]!;
    const mesh = buildGeometryMeshes(geo)[0]!;
    expect(mesh.positions.length / 3).toBe(4);
    expect(mesh.indices.length / 3).toBe(2);
    expect(mesh.faces).toEqual(["poly"]);
  });
});
