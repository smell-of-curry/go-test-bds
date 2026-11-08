import assert from "node:assert/strict";
import test from "node:test";
import { emptyBonePose } from "./animation";
import { addLocomotionPoses, createLocomotion } from "./locomotion";

test("a model Map.keys iterator applies the selected arm swing and every walking limb", () => {
  const bones = new Map(
    ["head", "leftArm", "leftLeg", "rightArm", "rightLeg"].map((name) => [
      name,
      {},
    ]),
  );
  const state = createLocomotion();
  state.swingAge = 0.175;
  state.phase = Math.PI / 2;
  state.amp = 1;
  const poses = new Map();
  addLocomotionPoses(state, bones.keys(), poses);
  assert.ok(
    poses.get("rightArm")?.rotation[0] < -50,
    "right arm must visibly swing forward",
  );
  assert.ok(
    poses.has("leftArm"),
    "bones before the selected arm must still receive their gait",
  );
  assert.ok(poses.has("leftLeg"));
  assert.ok(poses.has("rightLeg"));
});

test("single-use iterable also swings a lone left arm over an authored pose", () => {
  function* names() {
    yield "head";
    yield "leftArm";
  }
  const state = createLocomotion();
  state.swingAge = 0.175;
  const base = emptyBonePose();
  base.rotation = [12, 0, 5];
  const poses = new Map([["leftArm", base]]);
  addLocomotionPoses(state, names(), poses);
  assert.deepEqual(poses.get("leftArm")!.rotation, [-68, 0, 5]);
});
