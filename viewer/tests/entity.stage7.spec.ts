/**
 * Stage 7 pure-logic specs (material mapping, RC tint, equipment selection).
 * Node-side Playwright tests — this repo has no vitest (see package.json).
 */
import { expect, test } from "@playwright/test";
import {
  armourTextureStem,
  composeControllerTint,
  evalColor,
  evaluatePassTint,
  materialStateFromName,
  parseClientEntity,
  parseRenderControllers,
  resolveRenderPasses,
  selectArmourLayers,
  selectHeldItem,
  WHITE,
} from "../src/entity";

test.describe("material name → render state", () => {
  test("exact vanilla names", () => {
    expect(materialStateFromName("entity")).toMatchObject({
      transparency: "opaque",
      cull: true,
      emissive: false,
    });
    expect(materialStateFromName("entity_alphatest")).toMatchObject({
      transparency: "alpha_test",
      cull: true,
      alphaTest: 0.5,
    });
    expect(materialStateFromName("entity_alphablend")).toMatchObject({
      transparency: "blend",
      cull: true,
    });
    expect(materialStateFromName("entity_emissive")).toMatchObject({
      transparency: "opaque",
      emissive: true,
    });
    expect(materialStateFromName("entity_emissive_alpha")).toMatchObject({
      transparency: "alpha_test",
      cull: false,
      emissive: true,
    });
    expect(materialStateFromName("charged_creeper")).toMatchObject({
      transparency: "blend",
      emissive: true,
      cull: false,
    });
  });

  test("unknown short names default to alphatest cutout", () => {
    const d = materialStateFromName("sheep");
    expect(d.transparency).toBe("alpha_test");
    expect(d.alphaTest).toBe(0.5);
    expect(d.cull).toBe(true);
    expect(materialStateFromName("")).toEqual(materialStateFromName("sheep"));
  });

  test("pattern fallbacks", () => {
    expect(materialStateFromName("custom_alphablend_glow").transparency).toBe(
      "blend",
    );
    expect(materialStateFromName("foo_emissive_bar").emissive).toBe(true);
    expect(materialStateFromName("slime_outer").cull).toBe(false);
  });
});

test.describe("RC colour / overlay lerp", () => {
  test("evalColor reads numeric channels", () => {
    const c = evalColor(
      { r: 1, g: 0.5, b: "0.25", a: 1 },
      { type: "t", player: false, props: {}, flags: {} },
    );
    expect(c).toEqual({ r: 1, g: 0.5, b: 0.25, a: 1 });
  });

  test("overlay_color lerps toward colour by its alpha", () => {
    const tint = composeControllerTint({
      color: WHITE,
      overlay: { r: 1, g: 0, b: 0, a: 0.5 },
    });
    expect(tint.r).toBeCloseTo(1);
    expect(tint.g).toBeCloseTo(0.5);
    expect(tint.b).toBeCloseTo(0.5);
  });

  test("evaluatePassTint wires RC fields", () => {
    const tint = evaluatePassTint(
      {
        color: { r: 1, g: 1, b: 1, a: 1 },
        isHurtColor: { r: 1, g: 0, b: 0, a: 0.4 },
      },
      { type: "t", player: false, props: {}, flags: {} },
    );
    expect(tint.g).toBeCloseTo(0.6);
  });

  test("resolveRenderPasses carries materialName + tint", () => {
    const def = parseClientEntity({
      "minecraft:client_entity": {
        description: {
          identifier: "test:tint",
          materials: { default: "entity_emissive_alpha" },
          textures: { default: "textures/entity/x" },
          geometry: { default: "geometry.x" },
          render_controllers: ["controller.render.tint"],
        },
      },
    })!;
    const controllers = parseRenderControllers({
      format_version: "1.8.0",
      render_controllers: {
        "controller.render.tint": {
          geometry: "Geometry.default",
          materials: [{ "*": "Material.default" }],
          textures: ["Texture.default"],
          overlay_color: { r: 1, g: 0, b: 0, a: 0.5 },
        },
      },
    });
    const passes = resolveRenderPasses(def, controllers, {
      type: "test:tint",
      player: false,
      props: {},
      flags: {},
    });
    expect(passes).toHaveLength(1);
    expect(passes[0]!.materialName).toBe("entity_emissive_alpha");
    expect(passes[0]!.tint.g).toBeCloseTo(0.5);
  });
});

test.describe("equipment → geometry / texture", () => {
  test("armourTextureStem maps common materials", () => {
    expect(armourTextureStem("minecraft:iron_chestplate")).toBe("iron");
    expect(armourTextureStem("diamond_helmet")).toBe("diamond");
    expect(armourTextureStem("golden_leggings")).toBe("gold");
    expect(armourTextureStem("minecraft:stick")).toBeNull();
  });

  test("selectArmourLayers picks geometry + layer texture", () => {
    const layers = selectArmourLayers([
      { name: "minecraft:iron_helmet", count: 1 },
      { name: "minecraft:iron_chestplate", count: 1 },
      { name: "minecraft:iron_leggings", count: 1 },
      { name: "minecraft:iron_boots", count: 1 },
    ]);
    expect(layers).toHaveLength(4);
    expect(layers[0]).toEqual({
      slot: 0,
      geometryId: "geometry.humanoid.armor.helmet",
      texturePath: "textures/models/armor/iron_1",
    });
    expect(layers[2]!.texturePath).toBe("textures/models/armor/iron_2");
    expect(layers[2]!.geometryId).toBe("geometry.humanoid.armor.leggings");
  });

  test("selectHeldItem returns main-hand bone candidates", () => {
    const held = selectHeldItem({
      main: { name: "minecraft:diamond_sword", count: 1 },
      off: null,
    });
    expect(held?.item.name).toBe("minecraft:diamond_sword");
    expect(held?.boneCandidates).toContain("rightitem");
    expect(selectHeldItem({ main: null, off: null })).toBeNull();
  });
});
