import { expect, test } from "@playwright/test";
import {
  clearPermutationCache,
  effectiveComponents,
  evalPermutationCondition,
  facesFromMaterialInstances,
  materialForKey,
  materialFlags,
  mergeComponents,
  renderClassFromMethod,
  transformAboutBlockCenter,
} from "../src/terrain";
import type { RegistryBlock } from "../src/protocol";
import { BlockModelResolver } from "../src/terrain/resolve";
import { stripFormatCodes } from "../src/terrain/blockEntities";

test.describe("custom block permutations", () => {
  test.beforeEach(() => clearPermutationCache());

  test("permutation condition selects components", () => {
    const reg: RegistryBlock = {
      name: "fixture:custom_crate",
      components: {
        geometry: "geometry.fixture.custom_crate",
        materialInstances: {
          "*": { texture: "closed_tex", renderMethod: "opaque" },
        },
      },
      permutations: [
        {
          condition: "query.block_state('fixture:open') == true",
          components: {
            geometry: "geometry.fixture.custom_crate_open",
            materialInstances: {
              "*": { texture: "open_tex", renderMethod: "opaque" },
            },
          },
        },
      ],
    };

    const closed = effectiveComponents(reg, { "fixture:open": false });
    expect(closed.geometry).toBe("geometry.fixture.custom_crate");
    expect(closed.materialInstances?.["*"]?.texture).toBe("closed_tex");

    const open = effectiveComponents(reg, { "fixture:open": true });
    expect(open.geometry).toBe("geometry.fixture.custom_crate_open");
    expect(open.materialInstances?.["*"]?.texture).toBe("open_tex");

    expect(
      evalPermutationCondition("query.block_property('fixture:open') == true", {
        "fixture:open": true,
      }),
    ).toBe(true);
    expect(
      evalPermutationCondition("q.block_state('fixture:open') == true", {
        "fixture:open": false,
      }),
    ).toBe(false);
  });

  test("mergeComponents overlays materials", () => {
    const merged = mergeComponents(
      {
        geometry: "a",
        materialInstances: {
          "*": { texture: "base" },
          up: { texture: "up_base" },
        },
      },
      {
        materialInstances: { up: { texture: "up_over" } },
      },
    );
    expect(merged.geometry).toBe("a");
    expect(merged.materialInstances?.["*"]?.texture).toBe("base");
    expect(merged.materialInstances?.up?.texture).toBe("up_over");
  });
});

test.describe("material_instances", () => {
  test("face mapping + render_method resolution", () => {
    const mats = {
      "*": {
        texture: "all",
        renderMethod: "opaque",
        faceDimming: true,
        ambientOcclusion: true,
      },
      up: {
        texture: "top",
        renderMethod: "alpha_test",
        faceDimming: false,
        ambientOcclusion: false,
      },
      north: { texture: "front", renderMethod: "blend" },
    };
    const cube = facesFromMaterialInstances(mats)!;
    expect(cube.faces.up.texture).toBe("top");
    expect(cube.faces.down.texture).toBe("all");
    expect(cube.faces.north.texture).toBe("front");
    // First non-empty renderMethod wins in facesFromMaterialInstances —
    // walk faces in cardinal order; up comes first with alpha_test.
    expect(cube.renderClass).toBe("cutout");
    expect(renderClassFromMethod("blend")).toBe("translucent");
    expect(renderClassFromMethod("double_sided")).toBe("opaque");
    expect(materialForKey(mats, "east")?.texture).toBe("all");
    expect(materialFlags(mats.up).faceDimming).toBe(false);
    expect(materialFlags(mats.up).ambientOcclusion).toBe(false);
    expect(materialFlags(undefined).faceDimming).toBe(true);
  });
});

test.describe("geometry fallback + transform", () => {
  test("missing geometry falls back to cube (no customGeometryKey)", () => {
    const reg: RegistryBlock = {
      name: "fixture:geo_miss",
      components: {
        geometry: "geometry.does.not.exist",
        materialInstances: {
          "*": { texture: "palette_right_texture", renderMethod: "opaque" },
        },
      },
    };
    const resolver = new BlockModelResolver(
      {},
      {
        blocks: [reg],
        items: [],
        actors: [],
      },
    );
    // No geometry cache bound → cube path, faces still resolve.
    const cube = resolver.resolveCube(
      { name: "fixture:geo_miss", states: {}, rid: 1 },
      0,
      0,
      0,
    )!;
    expect(cube.customGeometryKey).toBeUndefined();
    expect(cube.faces.north.texture).toBe("palette_right_texture");
    expect(
      resolver.usesCustomGeometry({
        name: "fixture:geo_miss",
        states: {},
        rid: 1,
      }),
    ).toBe(false);
  });

  test("transformAboutBlockCenter rotates about 0.5", () => {
    // Point on +X face centre; 90° Y → should land near +Z.
    const [x, y, z] = transformAboutBlockCenter(1, 0.5, 0.5, {
      rx: 0,
      ry: 90,
      rz: 0,
      sx: 1,
      sy: 1,
      sz: 1,
      tx: 0,
      ty: 0,
      tz: 0,
    });
    expect(x).toBeCloseTo(0.5, 5);
    expect(y).toBeCloseTo(0.5, 5);
    expect(z).toBeCloseTo(0, 5);

    const scaled = transformAboutBlockCenter(0.5, 1, 0.5, {
      rx: 0,
      ry: 0,
      rz: 0,
      sx: 1,
      sy: 0.5,
      sz: 1,
      tx: 0,
      ty: 16, // 1 block up in pixels
      tz: 0,
    });
    expect(scaled[0]).toBeCloseTo(0.5, 5);
    expect(scaled[1]).toBeCloseTo(0.5 * 0.5 + 0.5 + 1, 5);
    expect(scaled[2]).toBeCloseTo(0.5, 5);
  });

  test("stripFormatCodes removes section signs", () => {
    expect(stripFormatCodes("§aHello§r")).toBe("Hello");
  });
});
