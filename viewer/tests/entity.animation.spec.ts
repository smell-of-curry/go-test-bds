import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAnimationBindings,
  catmullRom,
  EntityAnimator,
  isAnimationFinished,
  parseAnimControllers,
  parseAnimations,
  parseClientEntity,
  resolveSampleTime,
  sampleAnimationPoses,
  sampleChannel,
} from "../src/entity";
import { createDefaultHost } from "../src/molang";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "testdata", "entity");

/**
 * @param name - Fixture file under testdata/entity.
 * @returns parsed JSON.
 */
function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

/**
 * @returns minimal AnimEntityState.
 */
function ent(
  overrides: Partial<{
    pos: [number, number, number];
    vel: [number, number, number];
    flags: Record<string, boolean>;
  }> = {},
) {
  return {
    type: "test:blocky_anim",
    player: false,
    pos: overrides.pos ?? ([0, 0, 0] as [number, number, number]),
    rot: [0, 0] as [number, number],
    vel: overrides.vel ?? ([0, 0, 0] as [number, number, number]),
    flags: overrides.flags ?? {},
    props: {},
    attributes: {},
  };
}

test.describe("animation keyframes (node)", () => {
  const anims = parseAnimations(loadJson("blocky.animation.json"));

  test("parses loop modes and bone channels", () => {
    const nod = anims.get("animation.test.blocky.nod")!;
    expect(nod.loop).toBe(true);
    expect(nod.animationLength).toBe(1);
    expect(nod.bones.get("head")?.rotation?.keyframes).toHaveLength(3);

    const hold = anims.get("animation.test.blocky.hold")!;
    expect(hold.loop).toBe("hold_on_last_frame");
  });

  test("linear keyframes hit recorded midpoints", () => {
    const nod = anims.get("animation.test.blocky.nod")!;
    const ch = nod.bones.get("head")!.rotation!;
    const host = createDefaultHost();

    // 0 → 40 over first half-second (MS Learn continuous example).
    expect(sampleChannel(ch, 0, host, [0, 0, 0])[0]).toBeCloseTo(0, 5);
    expect(sampleChannel(ch, 0.25, host, [0, 0, 0])[0]).toBeCloseTo(20, 5);
    expect(sampleChannel(ch, 0.5, host, [0, 0, 0])[0]).toBeCloseTo(40, 5);
    expect(sampleChannel(ch, 0.75, host, [0, 0, 0])[0]).toBeCloseTo(20, 5);
    expect(sampleChannel(ch, 1.0, host, [0, 0, 0])[0]).toBeCloseTo(0, 5);
  });

  test("catmullrom midpoint matches uniform spline", () => {
    // Control posts: 0, 90, 0 — at u=0.5 between 0→90 with neighbours 0,90,0,0
    const expected = catmullRom(0, 0, 90, 0, 0.5);
    const smooth = anims.get("animation.test.blocky.smooth")!;
    const ch = smooth.bones.get("head")!.rotation!;
    const host = createDefaultHost();
    const mid = sampleChannel(ch, 0.25, host, [0, 0, 0])[0];
    // t=0.25 is u=0.5 on segment [0, 0.5]
    expect(mid).toBeCloseTo(expected, 5);
  });

  test("loop wrap / hold_on_last_frame / stop semantics", () => {
    const nod = anims.get("animation.test.blocky.nod")!;
    expect(resolveSampleTime(nod, 1.25)).toBeCloseTo(0.25, 5);

    const hold = anims.get("animation.test.blocky.hold")!;
    expect(resolveSampleTime(hold, 1.0)).toBeCloseTo(0.4, 5);
    expect(isAnimationFinished(hold, 0.4)).toBe(true);

    const raise = anims.get("animation.test.blocky.raise")!;
    expect(resolveSampleTime(raise, 0.6)).toBeNull();
    expect(isAnimationFinished(raise, 0.5)).toBe(true);
  });

  test("Molang-valued constant channel uses query.anim_time", () => {
    const spin = anims.get("animation.test.blocky.molang_spin")!;
    const host = createDefaultHost({ queries: { anim_time: 2 } });
    const poses = sampleAnimationPoses(spin, 2, host);
    expect(poses.get("body")!.rotation[0]).toBeCloseTo(180, 5);
  });

  test("position channel samples model-unit raise", () => {
    const raise = anims.get("animation.test.blocky.raise")!;
    const host = createDefaultHost();
    const poses = sampleAnimationPoses(raise, 0.25, host);
    // Linear 0 → 8 over 0.5s → 4 at t=0.25
    expect(poses.get("head")!.position[1]).toBeCloseTo(4, 5);
  });
});

test.describe("animation controllers + scripts (node)", () => {
  const anims = parseAnimations(loadJson("blocky.animation.json"));
  const controllers = parseAnimControllers(loadJson("blocky.ac.json"));
  const def = parseClientEntity(loadJson("animated.entity.json"))!;

  test("parses controller states and entity scripts", () => {
    const ac = controllers.get("controller.animation.test.blocky.move")!;
    expect(ac.initialState).toBe("idle");
    expect(ac.states.get("idle")!.blendTransition).toBeCloseTo(0.1, 5);
    expect(def.scripts.initialize).toEqual(["variable.mode = 0;"]);
    expect(def.scripts.animate[0]).toEqual({ name: "move" });
  });

  test("controller state sequence for scripted variable.mode", () => {
    const bindings = buildAnimationBindings(
      def.animations,
      def.scripts,
      anims,
      controllers,
    );
    const animator = new EntityAnimator(bindings, {
      type: def.identifier,
      player: false,
      props: {},
      flags: {},
    });

    // Boot → idle
    animator.tickPoses(0.05, ent());
    expect(
      animator.controllerStates()["controller.animation.test.blocky.move"],
    ).toBe("idle");
    expect(animator.molangHost.getVariable("mode")).toBe(0);
    // pre_animation wrote pulse
    expect(animator.molangHost.getVariable("pulse")).not.toBeNull();

    // Drive mode=1 → active
    animator.molangHost.setVariable("mode", 1);
    animator.tickPoses(0.05, ent());
    expect(
      animator.controllerStates()["controller.animation.test.blocky.move"],
    ).toBe("active");

    // Advance past raise (0.5s) → done via all_animations_finished
    for (let i = 0; i < 12; i++) {
      animator.molangHost.setVariable("mode", 1);
      animator.tickPoses(0.05, ent());
    }
    expect(
      animator.controllerStates()["controller.animation.test.blocky.move"],
    ).toBe("done");

    // mode=0 → idle
    animator.molangHost.setVariable("mode", 0);
    animator.tickPoses(0.05, ent());
    expect(
      animator.controllerStates()["controller.animation.test.blocky.move"],
    ).toBe("idle");

    expect(animator.stateLog).toEqual([
      "controller.animation.test.blocky.move:idle",
      "controller.animation.test.blocky.move:active",
      "controller.animation.test.blocky.move:done",
      "controller.animation.test.blocky.move:idle",
    ]);
  });

  test("initialize runs once; variables persist across frames", () => {
    const bindings = buildAnimationBindings(
      def.animations,
      def.scripts,
      anims,
      controllers,
    );
    const animator = new EntityAnimator(bindings, {
      type: def.identifier,
      player: false,
      props: {},
      flags: {},
    });
    animator.tickPoses(0.1, ent());
    animator.molangHost.setVariable("mode", 7);
    // Re-tick must NOT re-run initialize (would reset mode to 0).
    animator.tickPoses(0.1, ent());
    expect(animator.molangHost.getVariable("mode")).toBe(7);
  });

  test("modified_distance_moved accumulates horizontal travel", () => {
    const bindings = buildAnimationBindings(
      def.animations,
      def.scripts,
      anims,
      controllers,
    );
    const animator = new EntityAnimator(bindings, {
      type: def.identifier,
      player: false,
      props: {},
      flags: {},
    });
    animator.tickPoses(0.05, ent({ pos: [0, 0, 0] }));
    animator.tickPoses(0.05, ent({ pos: [3, 0, 4] })); // dist 5
    expect(
      animator.molangHost.query("modified_distance_moved", []),
    ).toBeCloseTo(5, 5);
  });
});
