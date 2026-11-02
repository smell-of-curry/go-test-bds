import assert from "node:assert/strict";
import { test } from "@playwright/test";
import { type BoneAnimPose, emptyBonePose } from "../src/entity/animation.ts";
import { addRidePoses } from "../src/entity/locomotion.ts";
import {
  createMoveTrack,
  stepHorizontalMove,
} from "../src/entity/moveSpeed.ts";

test("ride pose folds both legs and both arms, and leaves a posed bone", () => {
  const poses = new Map<string, BoneAnimPose>();
  poses.set("rightLeg", emptyBonePose());
  poses.get("rightLeg")!.rotation[0] = 5;
  addRidePoses(["leftLeg", "rightLeg", "leftArm", "rightArm", "head"], poses);
  assert.equal(poses.get("leftLeg")!.rotation[0], -80);
  assert.equal(poses.get("rightLeg")!.rotation[0], 5);
  assert.equal(poses.get("leftArm")!.rotation[0], -36);
  assert.equal(poses.get("rightArm")!.rotation[0], -36);
  assert.equal(poses.has("head"), false);
});

test("a zero-dt redraw keeps the last move speed", () => {
  const track = createMoveTrack();
  stepHorizontalMove(track, [0, 0, 0], 0.05, [0, 0, 0]);
  const moving = stepHorizontalMove(track, [0, 0, 1], 0.05, [0, 0, 0]);
  assert.ok(moving.moveSpeed > 0.05);
  const held = stepHorizontalMove(track, [0, 0, 1], 0, [0, 0, 0]);
  assert.ok(Math.abs(held.moveSpeed - moving.moveSpeed) < 1e-9);
});

test("zero-dt redraw does not consume the next movement sample", () => {
  const track = createMoveTrack();
  stepHorizontalMove(track, [0, 0, 0], 0.05, [0, 0, 0]);
  stepHorizontalMove(track, [0, 0, 1], 0, [0, 0, 0]);
  const next = stepHorizontalMove(track, [0, 0, 1], 0.05, [0, 0, 0]);
  assert.equal(next.distance, 1);
  assert.deepEqual(next.delta, [0, 0, 1]);
  const stopped = stepHorizontalMove(track, [0, 0, 1], 0.05, [0, 0, 0]);
  assert.ok(stopped.moveSpeed < next.moveSpeed);
});

test("zero-dt redraw still respects wire velocity", () => {
  const sample = stepHorizontalMove(
    createMoveTrack(),
    [0, 0, 0],
    0,
    [0.2, 0, 0],
  );
  assert.equal(sample.blocksPerSec, 4);
  assert.equal(sample.distance, 0);
});
