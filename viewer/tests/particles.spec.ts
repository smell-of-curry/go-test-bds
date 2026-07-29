import { expect, test } from "@playwright/test";
import * as THREE from "three";
import { createDefaultHost, sequenceRandom } from "../src/molang";
import {
  evalExpr,
  evaluateCurve,
  parseExpr,
  parseParticleEffect,
  ParticleSystem,
  sampleTintGradient,
} from "../src/particles";
import type { ParticleCurve } from "../src/particles/types";

const FIXTURE = {
  format_version: "1.10.0",
  particle_effect: {
    description: {
      identifier: "test:burst",
      basic_render_parameters: {
        material: "particles_blend",
        texture: "textures/particle/particles",
      },
    },
    curves: {
      "variable.size": {
        type: "linear",
        input: "v.particle_age",
        horizontal_range: "v.particle_lifetime",
        nodes: [0, 1, 0],
      },
      "variable.wiggle": {
        type: "catmull_rom",
        input: "v.particle_age",
        horizontal_range: 1,
        nodes: [0, 1, 0, 1],
      },
    },
    components: {
      "minecraft:emitter_rate_instant": { num_particles: 5 },
      "minecraft:emitter_lifetime_once": { active_time: 0.5 },
      "minecraft:emitter_shape_point": {
        offset: [0, 0, 0],
        direction: [0, 1, 0],
      },
      "minecraft:particle_lifetime_expression": { max_lifetime: 1 },
      "minecraft:particle_initial_speed": 2,
      "minecraft:particle_initial_spin": { rotation: 0, rotation_rate: 10 },
      "minecraft:particle_motion_dynamic": {
        linear_acceleration: [0, -1, 0],
        linear_drag_coefficient: 0,
      },
      "minecraft:particle_appearance_billboard": {
        size: ["0.1*variable.size", "0.1*variable.size"],
        facing_camera_mode: "lookat_xyz",
        uv: {
          texture_width: 128,
          texture_height: 128,
          uv: [0, 0],
          uv_size: [8, 8],
          flipbook: {
            base_UV: [0, 0],
            size_UV: [8, 8],
            step_UV: [8, 0],
            frames_per_second: 8,
            max_frame: 4,
            stretch_to_lifetime: true,
          },
        },
      },
      "minecraft:particle_appearance_tinting": {
        color: {
          gradient: {
            "0.0": [1, 0, 0, 1],
            "1.0": [0, 0, 1, 1],
          },
          interpolant: "v.particle_age / v.particle_lifetime",
        },
      },
      "minecraft:particle_kill_plane": [0, 1, 0, -100],
      "minecraft:particle_motion_collision": {
        collision_drag: 1,
        coefficient_of_restitution: 0,
        collision_radius: 0.1,
      },
    },
  },
};

test.describe("particle parser", () => {
  test("parses real-shaped effect + records unsupported", () => {
    const effect = parseParticleEffect(FIXTURE);
    expect(effect.identifier).toBe("test:burst");
    expect(effect.material).toBe("particles_blend");
    expect(effect.texture).toBe("textures/particle/particles");
    expect(effect.rate?.kind).toBe("instant");
    expect(effect.lifetime?.kind).toBe("once");
    expect(effect.shape?.kind).toBe("point");
    expect(effect.billboard?.flipbook).not.toBeNull();
    expect(effect.tinting?.kind).toBe("gradient");
    expect(effect.killPlane).toEqual([0, 1, 0, -100]);
    expect(effect.curves).toHaveLength(2);
    expect(effect.unsupportedComponents).toContain(
      "minecraft:particle_motion_collision",
    );
  });

  test("strips float suffixes in Molang fields", () => {
    const expr = parseExpr("0.2 / (math.random(0.0, 1.0) * 0.9 + 0.1)");
    const host = createDefaultHost({ random: sequenceRandom([0]) });
    // random=0 → 0.2 / 0.1 = 2
    expect(evalExpr(expr, host)).toBeCloseTo(2, 5);
  });
});

test.describe("particle curves", () => {
  test("linear + catmull_rom at known points", () => {
    const host = createDefaultHost({
      variables: { particle_age: 0.25, particle_lifetime: 1 },
    });
    const linear: ParticleCurve = {
      name: "size",
      type: "linear",
      input: parseExpr("v.particle_age"),
      horizontalRange: parseExpr("v.particle_lifetime"),
      nodes: [0, 1, 0],
      chainNodes: [],
    };
    // age/lifetime = 0.25 → quarter of [0,1,0] span → 0.5
    expect(evaluateCurve(linear, host)).toBeCloseTo(0.5, 5);

    const cr: ParticleCurve = {
      name: "wiggle",
      type: "catmull_rom",
      input: 0.5,
      horizontalRange: 1,
      nodes: [0, 1, 0, 1],
      chainNodes: [],
    };
    const v = evaluateCurve(cr, host);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1.5);
  });
});

test.describe("tint gradient", () => {
  test("samples between stops", () => {
    const mid = sampleTintGradient(
      [
        { t: 0, rgba: [1, 0, 0, 1] },
        { t: 1, rgba: [0, 0, 1, 1] },
      ],
      0.5,
    );
    expect(mid[0]).toBeCloseTo(0.5, 5);
    expect(mid[2]).toBeCloseTo(0.5, 5);
    expect(mid[3]).toBeCloseTo(1, 5);
  });
});

test.describe("emitter spawn counts", () => {
  test("rate_instant + rate_steady with seeded RNG", () => {
    const scene = new THREE.Scene();
    const rng = sequenceRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    const system = new ParticleSystem(scene, { random: rng });

    const instant = parseParticleEffect({
      particle_effect: {
        description: {
          identifier: "test:instant",
          basic_render_parameters: {
            material: "particles_alpha",
            texture: "textures/particle/particles",
          },
        },
        components: {
          "minecraft:emitter_rate_instant": { num_particles: 7 },
          "minecraft:emitter_lifetime_once": { active_time: 1 },
          "minecraft:emitter_shape_point": {},
          "minecraft:particle_lifetime_expression": { max_lifetime: 2 },
          "minecraft:particle_initial_speed": 0,
        },
      },
    });
    system.spawn(instant, [0, 0, 0]);
    expect(system.particleCount).toBe(7);

    const steady = parseParticleEffect({
      particle_effect: {
        description: {
          identifier: "test:steady",
          basic_render_parameters: {
            material: "particles_alpha",
            texture: "textures/particle/particles",
          },
        },
        components: {
          "minecraft:emitter_rate_steady": {
            spawn_rate: 10,
            max_particles: 100,
          },
          "minecraft:emitter_lifetime_once": { active_time: 2 },
          "minecraft:emitter_shape_point": {},
          "minecraft:particle_lifetime_expression": { max_lifetime: 5 },
          "minecraft:particle_initial_speed": 0,
        },
      },
    });
    system.clear();
    system.spawn(steady, [0, 64, 0]);
    expect(system.particleCount).toBe(0);
    // Runtime clamps dt to 0.25s/frame — two ticks ≈ 0.5s → 5 particles.
    system.tick(0.25);
    system.tick(0.25);
    expect(system.particleCount).toBe(5);
    system.clear();
  });
});
