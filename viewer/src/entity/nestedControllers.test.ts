import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAnimationBindings, EntityAnimator } from "./controllerRuntime";
import { parseAnimations } from "./parseAnimation";
import { parseAnimControllers } from "./parseAnimController";

const entity = {
  type: "minecraft:player",
  player: true,
  pos: [0, 0, 0] as [number, number, number],
  rot: [0, 0] as [number, number],
  vel: [0, 0, 0] as [number, number, number],
  flags: {},
  props: {},
  attributes: {},
};

function animator() {
  const animations = parseAnimations({
    animations: {
      "animation.test.walk": {
        loop: true,
        bones: { leftleg: { rotation: [20, 0, 0] } },
      },
      "animation.test.bob": {
        loop: true,
        bones: { rightarm: { rotation: [0, 0, 5] } },
      },
    },
  });
  const controllers = parseAnimControllers({
    animation_controllers: {
      "controller.test.root": {
        states: { default: { animations: [{ base: "variable.enabled" }] } },
      },
      "controller.test.base": {
        states: { default: { animations: ["walk", "bob", "root"] } },
      },
    },
  });
  const bindings = buildAnimationBindings(
    {
      root: "controller.test.root",
      base: "controller.test.base",
      walk: "animation.test.walk",
      bob: "animation.test.bob",
    },
    {
      initialize: ["variable.enabled = 0.5;"],
      pre_animation: [],
      animate: [{ name: "root" }],
    },
    animations,
    controllers,
  );
  return new EntityAnimator(bindings, entity, performance.now() / 1000);
}

test("nested player controllers preserve parent weights, compose bob and gait, and tolerate cycles", () => {
  const a = animator();
  const pose = a.tickPoses(0.05, entity);
  assert.equal(pose.get("leftleg")?.rotation[0], 10);
  assert.equal(pose.get("rightarm")?.rotation[2], 2.5);
});

test("disabled nested controller stops contributing and resumes without duplication", () => {
  const a = animator();
  a.tickPoses(0.05, entity);
  a.molangHost.setVariable("enabled", 0);
  assert.equal(a.tickPoses(0.05, entity).size, 0);
  a.molangHost.setVariable("enabled", 1);
  assert.equal(a.tickPoses(0.05, entity).get("leftleg")?.rotation[0], 20);
});

import { existsSync, readFileSync } from "node:fs";
import { parsePackJson } from "../terrain/assetClient";
import { parseClientEntity } from "./parseClient";
const baseline = "../.cache/baseline/v1.26.50.4/resource_pack";

test(
  "cached vanilla player plays bob, head look, walking and riding through root/base controllers",
  { skip: !existsSync(`${baseline}/entity/player.entity.json`) },
  () => {
    const load = (path: string) =>
      parsePackJson(readFileSync(`${baseline}/${path}`, "utf8"));
    const client = parseClientEntity(load("entity/player.entity.json"))!;
    const animations = new Map([
      ...parseAnimations(load("animations/player.animation.json")),
      ...parseAnimations(load("animations/humanoid.animation.json")),
    ]);
    const controllers = new Map([
      ...parseAnimControllers(
        load("animation_controllers/player.animation_controllers.json"),
      ),
      ...parseAnimControllers(
        load("animation_controllers/humanoid.animation_controllers.json"),
      ),
    ]);
    const a = new EntityAnimator(
      buildAnimationBindings(
        client.animations,
        client.scripts,
        animations,
        controllers,
      ),
      entity,
      performance.now() / 1000,
    );
    const walking = {
      ...entity,
      vel: [0.215, 0, 0] as [number, number, number],
      rot: [0, 15, 30] as [number, number, number],
    };
    let pose = a.tickPoses(0.05, walking);
    // Player gait follows authoritative travel, not a retained impulse.
    walking.pos = [walking.pos[0] + 0.215, walking.pos[1], walking.pos[2]];
    pose = a.tickPoses(0.05, walking);
    assert.ok(Math.abs(pose.get("leftarm")?.rotation[0] ?? 0) > 1);
    assert.ok(
      Math.abs(pose.get("rightarm")?.rotation[2] ?? 0) > 1,
      "vanilla arm bob",
    );
    assert.equal(pose.get("head")?.rotation[0], 15);
    assert.equal(pose.get("head")?.rotation[1], 30);
    const riding = a.tickPoses(0.05, { ...walking, vehicle: 42 });
    assert.ok(
      (riding.get("leftleg")?.rotation[0] ?? 0) < -40,
      "riding query folds legs",
    );
  },
);

import { sampleAnimation } from "./animation";
import { createDefaultHost } from "../molang";

test("Molang this replaces each accumulated axis without erasing other bones", () => {
  const anims = parseAnimations({
    animations: {
      walk: { loop: true, bones: { leftleg: { rotation: [20, 2, 3] } } },
      ride: {
        loop: true,
        bones: { leftleg: { rotation: ["-81 - this", "-18 - this", "-this"] } },
      },
    },
  });
  const poses = new Map();
  const host = createDefaultHost();
  sampleAnimation(anims.get("walk")!, 0, 1, host, poses);
  sampleAnimation(anims.get("ride")!, 0, 1, host, poses);
  assert.deepEqual(poses.get("leftleg").rotation, [-81, -18, 0]);
});

import { addLocomotionPoses, createLocomotion } from "./locomotion";
import { emptyBonePose } from "./animation";
test("recorded arm swings still play over pack-driven walking", () => {
  const pose = emptyBonePose();
  pose.rotation = [12, 0, 5];
  const poses = new Map([["rightarm", pose]]);
  const state = createLocomotion();
  state.swingAge = 0.175;
  addLocomotionPoses(state, ["rightarm"], poses);
  assert.deepEqual(poses.get("rightarm")!.rotation, [-68, 0, 5]);
});
