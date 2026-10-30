import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import {
  buildAnimationBindings,
  buildEntityModel,
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
import { parseGeometryDocument } from "../src/geometry";
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

  test("molang channels see the sample time, not a stale query.anim_time", () => {
    const bob = parseAnimations({
      format_version: "1.8.0",
      animations: {
        "animation.test.bob": {
          loop: true,
          animation_length: 4,
          bones: {
            root: {
              position: [0, "math.sin(query.anim_time * 90) * 4", 0],
            },
          },
        },
      },
    }).get("animation.test.bob")!;
    // Host left at anim_time 0. sin(90°) = 1 → y = 4. Stale 0 would yield 0.
    const poses = sampleAnimationPoses(bob, 1, createDefaultHost());
    expect(poses.get("root")!.position[1]).toBeCloseTo(4, 5);
  });

  test("loop playhead parked on the length keeps the end key", () => {
    const nod = anims.get("animation.test.blocky.nod")!;
    expect(resolveSampleTime(nod, 1)).toBeCloseTo(1, 5);
    expect(resolveSampleTime(nod, 1.25)).toBeCloseTo(0.25, 5);
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

  test("a late film tick still samples the idle, not the zero-weight blend", () => {
    // Pokémon controllers sit in an empty "default" state and blend 0.3s into
    // ground_idle. A film seek paints once at dt 0, so the transition frame
    // used to return no pose (incoming weight 0) and the model stayed in bind.
    const controllers = parseAnimControllers({
      format_version: "1.10.0",
      animation_controllers: {
        "controller.animation.test.spawn_idle": {
          initial_state: "default",
          states: {
            default: {
              transitions: [{ idle: "1" }],
              blend_transition: 0.3,
            },
            idle: { animations: ["nod"] },
          },
        },
      },
    });
    const bindings = buildAnimationBindings(
      {
        idle: "controller.animation.test.spawn_idle",
        nod: "animation.test.blocky.nod",
      },
      { initialize: [], pre_animation: [], animate: [{ name: "idle" }] },
      anims,
      controllers,
    );
    const born = performance.now() / 1000 - 0.5;
    const animator = new EntityAnimator(
      bindings,
      { type: "test:spawn_idle", player: false, props: {}, flags: {} },
      born,
    );
    const poses = animator.tickPoses(0, ent());
    expect(
      animator.controllerStates()["controller.animation.test.spawn_idle"],
    ).toBe("idle");
    // nod is 0 at t=0 and 40 at t=0.5. Half a second of age must show the pose.
    expect(poses.get("head")?.rotation[0]).toBeCloseTo(40, 0);
  });

  test("a cross-fade between two states that hide a bone keeps it hidden", () => {
    // Gengar's bite fangs are scale 0 in every idle. Weighting both states
    // into one accumulator multiplied the scales to a(1-a), so the fangs
    // popped to 25% size mid-fade (ground_idle -> air_idle on lift-off).
    const hideAnims = parseAnimations({
      format_version: "1.8.0",
      animations: {
        "animation.test.hide": { loop: true, bones: { fang: { scale: 0 } } },
      },
    });
    const controllers = parseAnimControllers({
      format_version: "1.10.0",
      animation_controllers: {
        "controller.animation.test.hide": {
          initial_state: "ground",
          states: {
            ground: {
              animations: ["hide"],
              transitions: [{ air: "v.up" }],
              blend_transition: 0.3,
            },
            air: { animations: ["hide"] },
          },
        },
      },
    });
    const bindings = buildAnimationBindings(
      { ctl: "controller.animation.test.hide", hide: "animation.test.hide" },
      { initialize: [], pre_animation: [], animate: [{ name: "ctl" }] },
      hideAnims,
      controllers,
    );
    const animator = new EntityAnimator(bindings, {
      type: "test:hide",
      player: false,
      props: {},
      flags: {},
    });
    animator.tickPoses(0.05, ent());
    animator.molangHost.setVariable("up", 1);
    animator.tickPoses(0.05, ent());
    const poses = animator.tickPoses(0.1, ent());
    expect(animator.controllerStates()["controller.animation.test.hide"]).toBe(
      "air",
    );
    expect(poses.get("fang")?.scale[0]).toBeCloseTo(0, 5);
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
    animator.tickPoses(0.05, ent({ pos: [0.6, 0, 0.8] })); // dist 1, under teleport
    expect(
      animator.molangHost.query("modified_distance_moved", []),
    ).toBeCloseTo(1, 5);
  });

  test("server animate plays the named anim, then drops it after its length", () => {
    const anims = parseAnimations({
      format_version: "1.8.0",
      animations: {
        "animation.test.oneshot": {
          animation_length: 0.2,
          loop: false,
          bones: { head: { rotation: [40, 0, 0] } },
        },
      },
    });
    const controllers = parseAnimControllers(loadJson("blocky.ac.json"));
    const bindings = buildAnimationBindings(
      { shot: "animation.test.oneshot" },
      { initialize: [], pre_animation: [], animate: [] },
      anims,
      controllers,
    );
    const orig = performance.now.bind(performance);
    let now = 10_000;
    performance.now = () => now;
    try {
      const animator = new EntityAnimator(bindings, {
        type: "test:oneshot",
        player: false,
        props: {},
        flags: {},
      });
      animator.playServerAnimation({
        animation: "animation.test.oneshot",
        stopExpression: "query.any_animation_finished",
        nextState: "done",
        blendOutTime: 0,
        startSec: now / 1000,
      });
      // nextState with no controller is ignored.
      expect(animator.controllerStates()).toEqual({});
      expect(animator.serverAnimations()).toContain("animation.test.oneshot");
      const playing = animator.tickPoses(0.05, ent());
      expect(playing.get("head")?.rotation[0]).toBeCloseTo(40, 5);

      now += 250;
      const done = animator.tickPoses(0.05, ent());
      expect(animator.serverAnimations()).not.toContain(
        "animation.test.oneshot",
      );
      expect(done.get("head")).toBeUndefined();

      // Short name from the client-entity animations map.
      animator.playServerAnimation({
        animation: "shot",
        blendOutTime: 0,
        startSec: now / 1000,
      });
      expect(animator.serverAnimations()).toContain("shot");
      now += 250;
      animator.tickPoses(0.05, ent());
      expect(animator.serverAnimations()).not.toContain("shot");
    } finally {
      performance.now = orig;
    }
  });

  test("server animate nextState jumps the named controller", () => {
    const anims = parseAnimations(loadJson("blocky.animation.json"));
    const extra = parseAnimations({
      format_version: "1.8.0",
      animations: {
        "animation.test.oneshot": {
          animation_length: 0.2,
          loop: false,
          bones: { head: { rotation: [40, 0, 0] } },
        },
      },
    });
    for (const [id, anim] of extra) anims.set(id, anim);
    const controllers = parseAnimControllers(loadJson("blocky.ac.json"));
    const client = parseClientEntity(loadJson("animated.entity.json"))!;
    const bindings = buildAnimationBindings(
      { ...client.animations, shot: "animation.test.oneshot" },
      client.scripts,
      anims,
      controllers,
    );
    const orig = performance.now.bind(performance);
    let now = 20_000;
    performance.now = () => now;
    try {
      const animator = new EntityAnimator(bindings, {
        type: client.identifier,
        player: false,
        props: {},
        flags: {},
      });
      animator.tickPoses(0.05, ent());
      animator.playServerAnimation({
        animation: "animation.test.oneshot",
        controller: "controller.animation.test.blocky.move",
        nextState: "done",
        blendOutTime: 0,
        startSec: now / 1000,
      });
      expect(
        animator.controllerStates()["controller.animation.test.blocky.move"],
      ).toBe("done");
      expect(animator.serverAnimations()).toContain("animation.test.oneshot");
      // Controller pose is replaced while the one-shot plays: head is the
      // oneshot's 40°, not the "done" state's hold animation.
      const poses = animator.tickPoses(0.05, ent());
      expect(poses.get("head")?.rotation[0]).toBeCloseTo(40, 5);
    } finally {
      performance.now = orig;
    }
  });

  test("head look comes from molang, not an automatic pitch, when the entity animates", () => {
    const anims = parseAnimations({
      format_version: "1.8.0",
      animations: {
        "animation.test.idle": {
          loop: true,
          bones: { body: { rotation: [0, 0, 0] } },
        },
      },
    });
    const bindings = buildAnimationBindings(
      { idle: "animation.test.idle" },
      { initialize: [], pre_animation: [], animate: [{ name: "idle" }] },
      anims,
      new Map(),
    );
    const geometry = parseGeometryDocument(
      JSON.parse(readFileSync(join(fixtures, "blocky.geo.json"), "utf8")),
    ).geometries[0]!;
    const model = buildEntityModel({
      geometry,
      texture: new THREE.Texture(),
    });
    const animator = new EntityAnimator(bindings, {
      type: "test:look",
      player: false,
      props: {},
      flags: {},
    });
    expect(animator.drivesHead()).toBe(true);
    animator.tick(
      0.05,
      {
        ...ent(),
        rot: [10, 40, 120],
      },
      model,
    );
    model.root.updateMatrixWorld(true);
    const face = new THREE.Vector3(0, 1, -0.5).applyMatrix4(
      model.bones.get("head")!.matrixWorld,
    );
    // Pitch 40 would drop this point below the pivot (y = 1).
    expect(face.y).toBeCloseTo(1, 4);
    expect(animator.molangHost.query("head_x_rotation", [])).toBe(40);
    expect(animator.molangHost.query("target_x_rotation", [])).toBe(40);
    expect(animator.molangHost.query("body_y_rotation", [])).toBe(10);
    // headYaw 120 − body 10 = 110, target_y clamped to 75.
    expect(animator.molangHost.query("head_y_rotation", [])).toBeCloseTo(
      110,
      5,
    );
    expect(animator.molangHost.query("target_y_rotation", [])).toBe(75);
    model.dispose();
  });

  test("entities with no client animations still pitch the head bone", () => {
    const bindings = buildAnimationBindings(
      {},
      { initialize: [], pre_animation: [], animate: [] },
      new Map(),
      new Map(),
    );
    const geometry = parseGeometryDocument(
      JSON.parse(readFileSync(join(fixtures, "blocky.geo.json"), "utf8")),
    ).geometries[0]!;
    const model = buildEntityModel({
      geometry,
      texture: new THREE.Texture(),
    });
    const animator = new EntityAnimator(bindings, {
      type: "test:plain",
      player: false,
      props: {},
      flags: {},
    });
    expect(animator.drivesHead()).toBe(false);
    animator.tick(0.05, { ...ent(), rot: [0, 45] }, model);
    model.root.updateMatrixWorld(true);
    const face = new THREE.Vector3(0, 1, -0.5).applyMatrix4(
      model.bones.get("head")!.matrixWorld,
    );
    expect(face.y).toBeLessThan(1);
    model.dispose();
  });

  test("walk speed comes from position when velocity is zero", () => {
    const anims = parseAnimations({
      format_version: "1.8.0",
      animations: {
        "animation.test.legs": {
          loop: true,
          bones: {
            leftleg: {
              rotation: [
                "(math.cos(query.modified_distance_moved * 38.17) * query.modified_move_speed / variable.gliding_speed_value) * 57.3",
                0,
                0,
              ],
            },
          },
        },
      },
    });
    const bindings = buildAnimationBindings(
      { legs: "animation.test.legs" },
      { initialize: [], pre_animation: [], animate: [{ name: "legs" }] },
      anims,
      new Map(),
    );
    const animator = new EntityAnimator(bindings, {
      type: "test:walker",
      player: false,
      props: {},
      flags: {},
    });
    const step = 0.05;
    const bps = 4.3;
    let x = 0;
    let peak = 0;
    // Seed, then one second of walking. vel stays 0 (player / teleport move).
    animator.tickPoses(step, ent({ pos: [0, 0, 0] }));
    for (let i = 0; i < 20; i++) {
      x += bps * step;
      const poses = animator.tickPoses(
        step,
        ent({ pos: [x, 0, 0], vel: [0, 0, 0] }),
      );
      peak = Math.max(peak, Math.abs(poses.get("leftleg")?.rotation[0] ?? 0));
    }
    expect(animator.horizontalBlocksPerSec).toBeGreaterThan(4);
    expect(animator.horizontalBlocksPerSec).toBeLessThan(4.5);
    // Vanilla scale is blocks/tick, so the leg formula stays a walk not a spin.
    expect(animator.molangHost.query("modified_move_speed", [])).toBeCloseTo(
      4.3 / 20,
      1,
    );
    expect(
      animator.molangHost.query("modified_distance_moved", []),
    ).toBeCloseTo(4.3, 1);
    expect(peak).toBeGreaterThan(8);
    expect(peak).toBeLessThan(20);
    expect(animator.molangHost.query("position_delta", [0])).toBeCloseTo(
      bps * step,
      5,
    );

    for (let i = 0; i < 20; i++) {
      animator.tickPoses(step, ent({ pos: [x, 0, 0] }));
    }
    expect(animator.horizontalBlocksPerSec).toBeLessThan(0.2);
    const stood = animator.tickPoses(step, ent({ pos: [x, 0, 0] }));
    expect(Math.abs(stood.get("leftleg")?.rotation[0] ?? 0)).toBeLessThan(2);

    const before = animator.molangHost.query(
      "modified_distance_moved",
      [],
    ) as number;
    animator.tickPoses(step, ent({ pos: [x + 10, 0, 0] }));
    expect(
      animator.molangHost.query("modified_distance_moved", []),
    ).toBeCloseTo(before, 5);
    expect(animator.horizontalBlocksPerSec).toBeLessThan(0.2);
    // The jump itself is still the per-frame delta.
    expect(animator.molangHost.query("position_delta", [0])).toBeCloseTo(10, 5);
  });

  test("runtime controller still plays a pack animation that is not a short name", () => {
    const anims = parseAnimations({
      format_version: "1.8.0",
      animations: {
        "animation.ball.capture": {
          animation_length: 3,
          bones: {
            pokeball: {
              rotation: {
                "0.0": { post: [37.5, 0, 0], lerp_mode: "catmullrom" },
                "0.4583": { post: [25, 0, 0], lerp_mode: "catmullrom" },
              },
              position: {
                "0.0": { post: [0, 0, 0], lerp_mode: "catmullrom" },
                "0.4583": { post: [0, 21.5, 5], lerp_mode: "catmullrom" },
              },
            },
          },
        },
      },
    });
    // Full id is in the pack map. The client-entity short-name map does not
    // have to list it for AnimateEntity to find it. `__runtime_controller`
    // is not a resource-pack controller.
    const bindings = buildAnimationBindings(
      {},
      { initialize: [], pre_animation: [], animate: [] },
      anims,
      new Map(),
    );
    const orig = performance.now.bind(performance);
    let now = 18_800;
    performance.now = () => now;
    try {
      const animator = new EntityAnimator(bindings, {
        type: "pokeb:ball_catch",
        player: false,
        props: {},
        flags: {},
      });
      animator.tickPoses(0.05, ent());
      animator.playServerAnimation({
        animation: "animation.ball.capture",
        nextState: "success3",
        stopExpression: "query.any_animation_finished",
        controller: "__runtime_controller",
        startSec: now / 1000,
      });
      expect(animator.serverAnimations()).toContain("animation.ball.capture");
      expect(animator.controllerStates()).toEqual({});
      const start = animator.tickPoses(0.05, ent());
      expect(start.get("pokeball")?.rotation[0]).toBeCloseTo(37.5, 4);
      now += 450;
      const mid = animator.tickPoses(0.05, ent());
      expect(mid.get("pokeball")?.position[1]).toBeGreaterThan(10);
    } finally {
      performance.now = orig;
    }
  });

  test("runtime controller nextState plays that short-name animation after the stop", () => {
    const anims = parseAnimations({
      format_version: "1.8.0",
      animations: {
        "animation.ball.capture": {
          animation_length: 1,
          bones: {
            pokeball: { position: { "0.0": [0, 4, 0], "1.0": [0, 4, 0] } },
          },
        },
        "animation.ball.success3": {
          animation_length: 2,
          bones: {
            pokeball: { rotation: { "0.0": [0, 0, 30], "2.0": [0, 0, 30] } },
          },
        },
      },
    });
    const bindings = buildAnimationBindings(
      {
        capture: "animation.ball.capture",
        success3: "animation.ball.success3",
      },
      { initialize: [], pre_animation: [], animate: [] },
      anims,
      new Map(),
    );
    const orig = performance.now.bind(performance);
    let now = 10_000;
    performance.now = () => now;
    try {
      const animator = new EntityAnimator(bindings, {
        type: "pokeb:ball_catch",
        player: false,
        props: {},
        flags: {},
      });
      animator.tickPoses(0.05, ent());
      animator.playServerAnimation({
        animation: "animation.ball.capture",
        nextState: "success3",
        stopExpression: "query.any_animation_finished",
        controller: "__runtime_controller",
        startSec: now / 1000,
      });
      expect(
        animator.tickPoses(0.05, ent()).get("pokeball")?.rotation[2] ?? 0,
      ).toBeCloseTo(0, 4);
      now += 1500;
      const shake = animator.tickPoses(0.05, ent()).get("pokeball");
      expect(shake?.rotation[2]).toBeCloseTo(30, 4);
      expect(shake?.position[1] ?? 0).toBeCloseTo(0, 4);
      now += 2000;
      expect(
        animator.tickPoses(0.05, ent()).get("pokeball")?.rotation[2] ?? 0,
      ).toBeCloseTo(0, 4);
    } finally {
      performance.now = orig;
    }
  });
});
