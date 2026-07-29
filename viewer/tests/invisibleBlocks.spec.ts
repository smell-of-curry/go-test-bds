/**
 * Invisible-in-client blocks: light blocks, barriers, structure void and
 * invisible bedrock render nothing (a real client shows them only as held-item
 * overlays). The mesher must treat them like air for emission and occlusion;
 * light levels are unaffected because light rides the wire from the Go bot.
 */
import { expect, test } from "@playwright/test";
import { BlockModelResolver, isInvisible } from "../src/terrain";
import type { Block } from "../src/protocol";

function block(name: string): Block {
  return { name, states: {}, rid: 1 };
}

test.describe("isInvisible", () => {
  test("matches light blocks, barrier, structure void, invisible bedrock", () => {
    expect(isInvisible(block("minecraft:light_block"))).toBe(true);
    expect(isInvisible(block("minecraft:light_block_0"))).toBe(true);
    expect(isInvisible(block("minecraft:light_block_15"))).toBe(true);
    expect(isInvisible(block("light_block_7"))).toBe(true);
    expect(isInvisible(block("minecraft:barrier"))).toBe(true);
    expect(isInvisible(block("minecraft:structure_void"))).toBe(true);
    expect(isInvisible(block("minecraft:invisible_bedrock"))).toBe(true);
    expect(isInvisible(block("minecraft:air"))).toBe(true);
    expect(isInvisible(undefined)).toBe(true);
  });

  test("leaves ordinary blocks visible", () => {
    expect(isInvisible(block("minecraft:stone"))).toBe(false);
    expect(isInvisible(block("minecraft:glass"))).toBe(false);
    // A custom block whose id merely contains "barrier" is not invisible.
    expect(isInvisible(block("pokeb:barrier_reef"))).toBe(false);
  });
});

test.describe("resolver treats invisible blocks as air", () => {
  const resolver = new BlockModelResolver({});

  test("renderClassOf → air, resolveCube → null, occludes → false", () => {
    for (const name of [
      "minecraft:light_block_9",
      "minecraft:barrier",
      "minecraft:structure_void",
      "minecraft:invisible_bedrock",
    ]) {
      const b = block(name);
      expect(resolver.renderClassOf(b), name).toBe("air");
      expect(resolver.resolveCube(b, 0, 0, 0), name).toBeNull();
      expect(resolver.occludes(b), name).toBe(false);
    }
  });
});
