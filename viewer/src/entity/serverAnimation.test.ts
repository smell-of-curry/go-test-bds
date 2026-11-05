import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAnimationBindings, EntityAnimator } from "./controllerRuntime";
import { parseAnimations } from "./parseAnimation";
import { parseAnimControllers } from "./parseAnimController";

// Primary semantics: blend_weight scales all authored transforms, including
// packet-driven plays; completion queries mean one full pass, even for loops.
// https://mojang.github.io/bedrock-samples/Animations.html
// https://learn.microsoft.com/en-us/minecraft/creator/reference/content/molangreference/examples/molangconcepts/queryfunctions/query_any_animation_finished
// https://learn.microsoft.com/en-us/minecraft/creator/reference/content/molangreference/examples/molangconcepts/queryfunctions/query_all_animations_finished
const entity = {
  type: "test:runtime",
  player: false,
  pos: [0, 0, 0] as [number, number, number],
  rot: [0, 0] as [number, number],
  vel: [0, 0, 0] as [number, number, number],
  props: {},
  flags: {},
  attributes: {},
};

/** Run with a deterministic packet/sample clock without a browser. */
function withClock(run: (set: (seconds: number) => void) => void): void {
  const original = performance.now;
  let now = 10;
  performance.now = () => now * 1000;
  try {
    run((seconds) => {
      now = seconds;
    });
  } finally {
    performance.now = original;
  }
}

function serverAnimator(def: Record<string, unknown>): EntityAnimator {
  return new EntityAnimator(
    buildAnimationBindings(
      { action: "animation.test.action" },
      { initialize: [], pre_animation: [], animate: [] },
      parseAnimations({ animations: { "animation.test.action": def } }),
      new Map(),
    ),
    entity,
  );
}

test("server blend_weight evaluates the play clock and multiplies its fade", () => {
  withClock((set) => {
    const animator = serverAnimator({
      animation_length: 1,
      blend_weight: "query.anim_time < 0.5 ? 0 : 0.25",
      bones: { body: { rotation: [20, 0, 0] } },
    });
    animator.playServerAnimation({ animation: "action", blendOutTime: 1 });
    set(10.25);
    assert.equal(animator.tickPoses(0, entity).get("body"), undefined);
    set(10.75);
    assert.equal(animator.tickPoses(0, entity).get("body")?.rotation[0], 5);
    set(11.5);
    assert.equal(animator.tickPoses(0, entity).get("body")?.rotation[0], 2.5);
    set(12);
    assert.equal(animator.tickPoses(0, entity).size, 0);
  });
});

for (const query of ["any_animation_finished", "all_animations_finished"]) {
  test(`server ${query} stops a loop after its first pass and fades out`, () => {
    withClock((set) => {
      const animator = serverAnimator({
        loop: true,
        animation_length: 1,
        bones: { body: { rotation: [20, 0, 0] } },
      });
      animator.playServerAnimation({
        animation: "action",
        controller: "__runtime_controller",
        stopExpression: `query.${query}`,
        blendOutTime: 0.5,
      });
      set(10.75);
      assert.equal(animator.tickPoses(0, entity).get("body")?.rotation[0], 20);
      set(11.25);
      assert.equal(animator.tickPoses(0, entity).get("body")?.rotation[0], 10);
      set(11.5);
      assert.equal(animator.tickPoses(0, entity).size, 0);
      assert.deepEqual(animator.serverAnimations(), []);
    });
  });
}

test("completion queries work in compound stops and latch during fade", () => {
  withClock((set) => {
    const animator = serverAnimator({
      loop: true,
      animation_length: 1,
      bones: { body: { rotation: [20, 0, 0] } },
    });
    animator.playServerAnimation({
      animation: "action",
      stopExpression: "query.all_animations_finished && variable.ready",
      blendOutTime: 0.5,
    });
    set(11.2);
    assert.equal(animator.tickPoses(0, entity).get("body")?.rotation[0], 20);
    animator.molangHost.setVariable("ready", 1);
    animator.tickPoses(0, entity);
    animator.molangHost.setVariable("ready", 0);
    set(11.45);
    assert.ok(
      Math.abs(
        (animator.tickPoses(0, entity).get("body")?.rotation[0] ?? 0) - 10,
      ) < 1e-8,
    );
    set(11.75);
    assert.equal(animator.tickPoses(0, entity).size, 0);
  });
});

test("a server loop without a completion stop remains active", () => {
  withClock((set) => {
    const animator = serverAnimator({
      loop: true,
      animation_length: 1,
      bones: { body: { rotation: [20, 0, 0] } },
    });
    animator.playServerAnimation({ animation: "action" });
    set(15);
    assert.equal(animator.tickPoses(0, entity).get("body")?.rotation[0], 20);
    assert.deepEqual(animator.serverAnimations(), ["action"]);
  });
});

for (const query of ["any_animation_finished", "all_animations_finished"]) {
  test(`authored controller ${query} includes both looping animations`, () => {
    withClock(() => {
      const animations = parseAnimations({
        animations: {
          fast: {
            loop: true,
            animation_length: 1,
            bones: { body: { rotation: [20, 0, 0] } },
          },
          slow: {
            loop: true,
            animation_length: 2,
            bones: { head: { rotation: [10, 0, 0] } },
          },
        },
      });
      const controllers = parseAnimControllers({
        animation_controllers: {
          "controller.test.root": {
            states: {
              default: {
                animations: ["fast", "slow"],
                transitions: [{ done: `query.${query}` }],
              },
              done: {},
            },
          },
        },
      });
      const animator = new EntityAnimator(
        buildAnimationBindings(
          { root: "controller.test.root", fast: "fast", slow: "slow" },
          { initialize: [], pre_animation: [], animate: [{ name: "root" }] },
          animations,
          controllers,
        ),
        entity,
      );
      animator.tickPoses(0.9, entity);
      assert.equal(
        animator.controllerStates()["controller.test.root"],
        "default",
      );
      animator.tickPoses(0.3, entity);
      assert.equal(
        animator.controllerStates()["controller.test.root"],
        query === "any_animation_finished" ? "done" : "default",
      );
      const pose = animator.tickPoses(1, entity);
      assert.equal(animator.controllerStates()["controller.test.root"], "done");
      assert.equal(pose.size, 0);
    });
  });
}
