/**
 * Pure checks for the film-look additions: entity shade, cloud drift, wave emote.
 * No WebGL — these must not depend on a GPU.
 */
import { expect, test } from "@playwright/test";
import {
  cloudDriftBlocks,
  CLOUD_Y,
  CLOUD_CELL,
  CLOUD_THICKNESS,
} from "../src/clouds";
import {
  builtinEmote,
  EMOTE_DURATION_SEC,
  WAVE_EMOTE_ID,
} from "../src/entity/emotes";
import { entityShade } from "../src/entity/lighting";
import { shadowQuads } from "../src/entity/shadow";
import { sampleAnimationPoses } from "../src/entity/animation";
import { createDefaultHost } from "../src/molang";

test.describe("film look math", () => {
  test("entity shade is top-bright and bottom-dark", () => {
    const up = entityShade(0, 1, 0);
    const down = entityShade(0, -1, 0);
    const sideX = entityShade(1, 0, 0);
    const sideZ = entityShade(0, 0, 1);
    expect(up).toBeGreaterThan(0.95);
    expect(down).toBeCloseTo(0.4, 5);
    expect(sideZ).toBeGreaterThan(sideX);
    expect(sideX).toBeGreaterThan(down);
    expect(sideZ).toBeLessThan(up);
  });

  test("cloud drift is deterministic and +X", () => {
    expect(CLOUD_Y).toBe(192);
    expect(CLOUD_CELL).toBe(12);
    expect(CLOUD_THICKNESS).toBe(4);
    expect(cloudDriftBlocks(0)).toBe(0);
    expect(cloudDriftBlocks(1000)).toBeCloseTo(0.6, 5);
    expect(cloudDriftBlocks(1000)).toBe(cloudDriftBlocks(1000));
  });

  test("wave emote raises the right arm then returns", () => {
    const anim = builtinEmote(WAVE_EMOTE_ID);
    expect(anim).not.toBeNull();
    expect(builtinEmote("not-a-real-emote")).toBeNull();
    const host = createDefaultHost();
    const mid = sampleAnimationPoses(anim!, 0.5, host);
    const arm = mid.get("rightArm");
    expect(arm).toBeTruthy();
    expect(arm!.rotation[0]).toBeLessThan(-100);
    expect(Math.abs(arm!.rotation[2])).toBeGreaterThan(5);
    const end = sampleAnimationPoses(anim!, EMOTE_DURATION_SEC, host);
    const back = end.get("rightArm");
    expect(back!.rotation[0]).toBeCloseTo(0, 3);
    expect(
      sampleAnimationPoses(anim!, EMOTE_DURATION_SEC + 0.5, host).size,
    ).toBe(0);
  });

  test("blob shadow lands on the block under the feet and fades when high", () => {
    const solid = (x: number, y: number, z: number) =>
      y === 4 && x === 0 && z === 0;
    const onGround = shadowQuads(0.2, 5, 0.2, 0.6, solid);
    expect(onGround.length).toBe(1);
    expect(onGround[0]!.y).toBe(5);
    expect(onGround[0]!.fade).toBeCloseTo(1, 2);
    const high = shadowQuads(0.2, 8.5, 0.2, 0.6, solid);
    expect(high.length).toBe(1);
    expect(high[0]!.fade).toBeLessThan(0.2);
    const flying = shadowQuads(0.2, 20, 0.2, 0.6, solid);
    expect(flying.length).toBe(0);
  });
});
