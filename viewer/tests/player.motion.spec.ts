import { expect, test } from "@playwright/test";
import {
  buildAnimationBindings,
  createMoveTrack,
  EntityAnimator,
  parseAnimations,
  stepHorizontalMove,
  type AnimEntityState,
} from "../src/entity";

/** Recorded observer state after a player's acceptance knockback settled. */
const settledSteve: AnimEntityState = {
  type: "minecraft:player",
  player: true,
  pos: [243.5, 83.00001037597656, 251.62806701660156],
  rot: [-180, 0, 180],
  vel: [0, 0.20000000298023224, 0.800000011920929],
  flags: {},
  props: {},
  attributes: {},
};

test("settled remote player does not keep walking from a stale knockback impulse", () => {
  const animations = parseAnimations({
    format_version: "1.8.0",
    animations: {
      "animation.test.player_walk": {
        loop: true,
        bones: {
          leftleg: { rotation: ["query.modified_move_speed * 57.3", 0, 0] },
        },
      },
    },
  });
  const bindings = buildAnimationBindings(
    { walk: "animation.test.player_walk" },
    { initialize: [], pre_animation: [], animate: [{ name: "walk" }] },
    animations,
    new Map(),
  );
  const animator = new EntityAnimator(bindings, settledSteve);
  animator.tickPoses(0, {
    ...settledSteve,
    pos: [243.5, 83, 251.12469482421875],
  });
  animator.tickPoses(0.1, settledSteve);
  expect(animator.horizontalBlocksPerSec).toBeGreaterThan(1);
  // Advance the film clock, not a number-of-frames expiry. Repeated presents
  // of one instant must neither consume movement nor revive the wire impulse.
  for (let i = 0; i < 20; i++) {
    animator.tickPoses(0.05, settledSteve);
    const speed = animator.horizontalBlocksPerSec;
    for (let present = 0; present < 3; present++)
      animator.tickPoses(0, settledSteve);
    expect(animator.horizontalBlocksPerSec).toBe(speed);
  }
  const poses = animator.tickPoses(0, settledSteve);
  expect(animator.horizontalBlocksPerSec).toBeLessThan(0.01);
  expect(Math.abs(poses.get("leftleg")!.rotation[0])).toBeLessThan(0.1);
  expect(animator.molangHost.query("modified_distance_moved", [])).toBeCloseTo(
    251.62806701660156 - 251.12469482421875,
  );
});

test("position-driven gait is independent of redraw count and retains genuine walking", () => {
  const a = createMoveTrack(),
    b = createMoveTrack();
  for (const track of [a, b])
    stepHorizontalMove(track, [0, 0, 0], 0, settledSteve.vel, "position");
  for (let i = 1; i <= 20; i++) {
    const pos: [number, number, number] = [0, 0, i * 0.215];
    const once = stepHorizontalMove(a, pos, 0.05, settledSteve.vel, "position");
    const redraw = stepHorizontalMove(
      b,
      pos,
      0.05,
      settledSteve.vel,
      "position",
    );
    for (let j = 0; j < 10; j++) {
      expect(
        stepHorizontalMove(b, pos, 0, settledSteve.vel, "position")
          .blocksPerSec,
      ).toBe(redraw.blocksPerSec);
    }
    expect(redraw.blocksPerSec).toBeCloseTo(once.blocksPerSec, 10);
  }
  expect(a.smoothed).toBeGreaterThan(4.2);
  expect(a.smoothed).toBeLessThan(4.4);
});

test("non-player velocity-driven actors and bike redraws keep their wire speed", () => {
  const bindings = buildAnimationBindings(
    {},
    { initialize: [], pre_animation: [], animate: [] },
    new Map(),
    new Map(),
  );
  const bike = {
    ...settledSteve,
    type: "test:bike",
    player: false,
    vel: [0, 0, 0.2] as [number, number, number],
  };
  const animator = new EntityAnimator(bindings, bike);
  for (let i = 0; i < 60; i++) {
    animator.tickPoses(0.05, bike);
    animator.tickPoses(0, bike);
    expect(animator.horizontalBlocksPerSec).toBe(4);
  }
});
