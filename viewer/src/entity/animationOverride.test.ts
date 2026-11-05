import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultHost } from "../molang";
import {
  emptyBonePose,
  mixBonePoses,
  sampleAnimation,
  type BoneAnimPose,
} from "./animation";
import { parseAnimations } from "./parseAnimation";

// Mojang Animations reference: override_previous_animation resets each named
// bone to its bind pose before applying that animation. Other bones survive.
const animations = parseAnimations({
  animations: {
    idle: {
      loop: true,
      bones: {
        wing: { rotation: [0, 46, 0], position: [2, 3, 4], scale: [2, 2, 2] },
        tail: { rotation: [0, 15, 0] },
      },
    },
    attack: {
      loop: true,
      override_previous_animation: true,
      bones: { wing: { rotation: [0, "20 + this", 0] } },
    },
  },
});

function idle(): Map<string, BoneAnimPose> {
  const out = new Map<string, BoneAnimPose>();
  sampleAnimation(animations.get("idle")!, 0, 1, createDefaultHost(), out);
  return out;
}

test("override animation resets prior channels and this, preserving unrelated bones", () => {
  const out = idle();
  sampleAnimation(animations.get("attack")!, 0, 1, createDefaultHost(), out);
  assert.deepEqual(out.get("wing"), {
    ...emptyBonePose(),
    rotation: [0, 20, 0],
    override: true,
  });
  assert.deepEqual(out.get("tail")?.rotation, [0, 15, 0]);
});

test("disabled override leaves earlier animation intact", () => {
  const out = idle();
  const before = structuredClone(out);
  sampleAnimation(animations.get("attack")!, 0, 0, createDefaultHost(), out);
  assert.deepEqual(out, before);
});

test("controller blend carries override and a completed transition releases it", () => {
  const out = idle();
  const override = new Map<string, BoneAnimPose>([
    ["wing", { ...emptyBonePose(), rotation: [0, 20, 0], override: true }],
  ]);
  const plain = new Map<string, BoneAnimPose>([
    ["wing", { ...emptyBonePose(), rotation: [0, 30, 0] }],
  ]);
  mixBonePoses(override, plain, 0.5, 1, out);
  assert.deepEqual(out.get("wing")?.rotation, [0, 25, 0]);
  assert.deepEqual(out.get("wing")?.scale, [1, 1, 1]);
  const ended = idle();
  mixBonePoses(override, plain, 1, 1, ended);
  assert.deepEqual(ended.get("wing")?.rotation, [0, 76, 0]);
});
