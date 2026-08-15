import { expect, test } from "@playwright/test";
import {
  bobbingFromSearch,
  cameraModeFromSearch,
  DEFAULT_FOV,
  easeProgress,
  FOLLOW_BACK,
  lerp,
  resolveFov,
  SPRINT_FOV_BONUS,
  viewBobOffset,
} from "../src/camera";
import type { Actor } from "../src/protocol";

function stubActor(partial: Partial<Actor>): Actor {
  return {
    rid: 1,
    uid: 1,
    name: "Bot",
    pos: [0, 64, 0],
    eyePos: [0, 65.62, 0],
    rot: [0, 0],
    vel: [0, 0, 0],
    onGround: true,
    gamemode: 0,
    dimension: 0,
    health: 20,
    maxHealth: 20,
    food: 20,
    heldSlot: 0,
    sneaking: false,
    sprinting: false,
    swimming: false,
    gliding: false,
    hotbar: [],
    inventory: [],
    offhand: null,
    armour: [null, null, null, null],
    effects: [],
    chunkRadius: 4,
    ...partial,
  };
}

test.describe("camera query + FOV", () => {
  test("cameraModeFromSearch", () => {
    expect(cameraModeFromSearch("?camera=follow")).toBe("follow");
    expect(cameraModeFromSearch("?camera=orbit")).toBe("orbit");
    expect(cameraModeFromSearch("")).toBe("firstPerson");
  });

  test("bobbing defaults off", () => {
    expect(bobbingFromSearch("")).toBe(false);
    expect(bobbingFromSearch("?camera=follow")).toBe(false);
    expect(bobbingFromSearch("?bobbing=1")).toBe(true);
  });

  test("resolveFov sprint and override", () => {
    expect(resolveFov(DEFAULT_FOV, stubActor({}), null)).toBe(DEFAULT_FOV);
    expect(resolveFov(DEFAULT_FOV, stubActor({ sprinting: true }), null)).toBe(
      DEFAULT_FOV + SPRINT_FOV_BONUS,
    );
    expect(resolveFov(DEFAULT_FOV, stubActor({ sprinting: true }), 50)).toBe(
      50,
    );
  });

  test("third-person distance is Bedrock 4 blocks", () => {
    expect(FOLLOW_BACK).toBe(4);
  });
});

test.describe("camera ease / bob state machine", () => {
  test("easeProgress snaps and clamps", () => {
    expect(easeProgress(0, 0)).toBe(1);
    expect(easeProgress(250, 500)).toBeCloseTo(0.5);
    expect(easeProgress(999, 500)).toBe(1);
  });

  test("lerp", () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
  });

  test("view bob only in follow + enabled + moving on ground", () => {
    const moving = stubActor({
      onGround: true,
      vel: [0.2, 0, 0],
    });
    expect(viewBobOffset(moving, 1, false, "follow")).toBe(0);
    expect(viewBobOffset(moving, 1, true, "firstPerson")).toBe(0);
    expect(viewBobOffset(moving, 1, true, "follow")).not.toBe(0);
    expect(
      viewBobOffset(
        stubActor({ onGround: false, vel: [1, 0, 0] }),
        1,
        true,
        "follow",
      ),
    ).toBe(0);
  });
});
