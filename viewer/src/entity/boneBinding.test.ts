import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { applyBonePoses, emptyBonePose, setBoneLocalPose } from "./animation";

function arm() {
  const group = new THREE.Group();
  group.userData.bedrockPose = {
    pivot: [5, 22, 0],
    rotation: [0, 0, 0],
    bindPoseRotation: [0, 0, 0],
  };
  return group;
}
function pose(z: number) {
  const value = emptyBonePose();
  value.rotation[2] = z;
  return value;
}

test("lowercase vanilla idle channels animate camelCase humanoid limbs", () => {
  const actual = arm();
  const expected = arm();
  const bones = new Map([["rightArm", actual]]);
  applyBonePoses(bones, new Map([["rightarm", pose(5)]]));
  setBoneLocalPose(expected, pose(5));
  assert.deepEqual(actual.matrix.elements, expected.matrix.elements);
  const first = actual.matrix.clone();
  applyBonePoses(bones, new Map([["rightarm", pose(-3)]]));
  setBoneLocalPose(expected, pose(-3));
  assert.deepEqual(actual.matrix.elements, expected.matrix.elements);
  assert.notDeepEqual(actual.matrix.elements, first.elements);
});

test("exact emote channel takes precedence over lowercase idle channel", () => {
  const actual = arm();
  const expected = arm();
  applyBonePoses(
    new Map([["rightArm", actual]]),
    new Map([
      ["rightarm", pose(5)],
      ["rightArm", pose(90)],
    ]),
  );
  setBoneLocalPose(expected, pose(90));
  assert.deepEqual(actual.matrix.elements, expected.matrix.elements);
});

test("case-insensitive fallback rejects ambiguous channel names", () => {
  const actual = arm();
  const expected = arm();
  applyBonePoses(
    new Map([["RightArm", actual]]),
    new Map([
      ["rightarm", pose(5)],
      ["rightArm", pose(90)],
    ]),
  );
  setBoneLocalPose(expected, emptyBonePose());
  assert.deepEqual(actual.matrix.elements, expected.matrix.elements);
});
