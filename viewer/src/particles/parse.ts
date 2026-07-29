import { parseExpr, parseVec3 } from "./expr";
import type {
  BillboardAppearance,
  EmitterLifetime,
  EmitterRate,
  EmitterShape,
  FlipbookUv,
  MolangExpr,
  ParsedParticleEffect,
  ParticleCurve,
  TintColor,
} from "./types";

const IMPLEMENTED = new Set([
  "minecraft:emitter_rate_instant",
  "minecraft:emitter_rate_steady",
  "minecraft:emitter_rate_manual",
  "minecraft:emitter_lifetime_once",
  "minecraft:emitter_lifetime_looping",
  "minecraft:emitter_lifetime_expression",
  "minecraft:emitter_shape_point",
  "minecraft:emitter_shape_sphere",
  "minecraft:emitter_shape_box",
  "minecraft:emitter_shape_disc",
  "minecraft:particle_lifetime_expression",
  "minecraft:particle_initial_speed",
  "minecraft:particle_initial_spin",
  "minecraft:particle_motion_dynamic",
  "minecraft:particle_motion_parametric",
  "minecraft:particle_appearance_billboard",
  "minecraft:particle_appearance_tinting",
  "minecraft:particle_kill_plane",
  // Present in almost every vanilla effect; lighting is a no-op under unlit Points.
  "minecraft:particle_appearance_lighting",
]);

/**
 * Parse a Bedrock `particle_effect` JSON document (format 1.10+).
 * Unknown components are recorded on the result and never throw.
 *
 * @param raw - Parsed JSON root (or the inner `particle_effect` object).
 * @returns normalised effect description.
 */
export function parseParticleEffect(raw: unknown): ParsedParticleEffect {
  const root = asRecord(raw) ?? {};
  const effect =
    asRecord(root.particle_effect) ??
    (root.description || root.components ? root : {});
  const desc = asRecord(effect.description) ?? {};
  const brp = asRecord(desc.basic_render_parameters) ?? {};
  const identifier =
    typeof desc.identifier === "string" ? desc.identifier : "unknown";
  const material =
    typeof brp.material === "string" ? brp.material : "particles_alpha";
  const texture =
    typeof brp.texture === "string"
      ? brp.texture
      : "textures/particle/particles";

  const curves = parseCurves(effect.curves);
  const components = asRecord(effect.components) ?? {};
  const unsupported: string[] = [];

  let rate: EmitterRate | null = null;
  let lifetime: EmitterLifetime | null = null;
  let shape: EmitterShape | null = null;
  let particleMaxLifetime: MolangExpr | null = null;
  let initialSpeed: MolangExpr | null = null;
  let initialRotation: MolangExpr | null = null;
  let initialRotationRate: MolangExpr | null = null;
  let motionDynamic: ParsedParticleEffect["motionDynamic"] = null;
  let motionParametric: ParsedParticleEffect["motionParametric"] = null;
  let billboard: BillboardAppearance | null = null;
  let tinting: TintColor | null = null;
  let killPlane: [number, number, number, number] | null = null;

  for (const [key, value] of Object.entries(components)) {
    const name = key.toLowerCase();
    if (!IMPLEMENTED.has(name)) {
      if (!unsupported.includes(name)) unsupported.push(name);
      // Still try a few soft mappings below for shape aliases.
    }
    switch (name) {
      case "minecraft:emitter_rate_instant": {
        const o = asRecord(value) ?? {};
        rate = { kind: "instant", numParticles: parseExpr(o.num_particles, 1) };
        break;
      }
      case "minecraft:emitter_rate_steady": {
        const o = asRecord(value) ?? {};
        rate = {
          kind: "steady",
          spawnRate: parseExpr(o.spawn_rate, 1),
          maxParticles: parseExpr(o.max_particles, 50),
        };
        break;
      }
      case "minecraft:emitter_rate_manual": {
        const o = asRecord(value) ?? {};
        rate = {
          kind: "manual",
          maxParticles: parseExpr(o.max_particles, 50),
        };
        break;
      }
      case "minecraft:emitter_lifetime_once": {
        const o = asRecord(value) ?? {};
        lifetime = {
          kind: "once",
          activeTime: parseExpr(o.active_time, 1),
        };
        break;
      }
      case "minecraft:emitter_lifetime_looping": {
        const o = asRecord(value) ?? {};
        lifetime = {
          kind: "looping",
          activeTime: parseExpr(o.active_time, 1),
          sleepTime: parseExpr(o.sleep_time, 0),
        };
        break;
      }
      case "minecraft:emitter_lifetime_expression": {
        const o = asRecord(value) ?? {};
        lifetime = {
          kind: "expression",
          activation:
            o.activation_expression !== undefined
              ? parseExpr(o.activation_expression, 1)
              : null,
          expiration:
            o.expiration_expression !== undefined
              ? parseExpr(o.expiration_expression, 0)
              : null,
        };
        break;
      }
      case "minecraft:emitter_shape_point":
        shape = parseShapePoint(value);
        break;
      case "minecraft:emitter_shape_sphere":
        shape = parseShapeSphere(value);
        break;
      case "minecraft:emitter_shape_box":
        shape = parseShapeBox(value);
        break;
      case "minecraft:emitter_shape_disc":
        shape = parseShapeDisc(value);
        break;
      case "minecraft:particle_lifetime_expression": {
        const o = asRecord(value) ?? {};
        particleMaxLifetime = parseExpr(o.max_lifetime, 1);
        break;
      }
      case "minecraft:particle_initial_speed":
        initialSpeed = parseExpr(
          value && typeof value === "object" && !Array.isArray(value)
            ? ((asRecord(value) ?? {}).speed ?? value)
            : value,
          0,
        );
        break;
      case "minecraft:particle_initial_spin": {
        const o = asRecord(value) ?? {};
        initialRotation = parseExpr(o.rotation, 0);
        initialRotationRate = parseExpr(o.rotation_rate, 0);
        break;
      }
      case "minecraft:particle_motion_dynamic": {
        const o = asRecord(value) ?? {};
        motionDynamic = {
          linearAcceleration: parseVec3(o.linear_acceleration, [0, 0, 0]),
          linearDrag: parseExpr(o.linear_drag_coefficient, 0),
          rotationAcceleration: parseExpr(o.rotation_acceleration, 0),
          rotationDrag: parseExpr(o.rotation_drag_coefficient, 0),
        };
        break;
      }
      case "minecraft:particle_motion_parametric": {
        const o = asRecord(value) ?? {};
        motionParametric = {
          relativePosition: Array.isArray(o.relative_position)
            ? parseVec3(o.relative_position)
            : null,
          direction: Array.isArray(o.relative_direction)
            ? parseVec3(o.relative_direction)
            : Array.isArray(o.direction)
              ? parseVec3(o.direction)
              : null,
        };
        break;
      }
      case "minecraft:particle_appearance_billboard":
        billboard = parseBillboard(value);
        break;
      case "minecraft:particle_appearance_tinting":
        tinting = parseTinting(value);
        break;
      case "minecraft:particle_kill_plane":
        killPlane = parseKillPlane(value);
        break;
      case "minecraft:particle_appearance_lighting":
        break;
      default:
        break;
    }
  }

  return {
    identifier,
    material,
    texture,
    curves,
    rate,
    lifetime,
    shape,
    particleMaxLifetime,
    initialSpeed,
    initialRotation,
    initialRotationRate,
    motionDynamic,
    motionParametric,
    billboard,
    tinting,
    killPlane,
    unsupportedComponents: unsupported,
  };
}

function parseCurves(raw: unknown): ParticleCurve[] {
  const obj = asRecord(raw);
  if (!obj) return [];
  const out: ParticleCurve[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const name = key.replace(/^variable\./i, "").toLowerCase();
    const o = asRecord(value) ?? {};
    const typeRaw =
      typeof o.type === "string" ? o.type.toLowerCase() : "linear";
    const type: ParticleCurve["type"] =
      typeRaw === "linear" ||
      typeRaw === "bezier" ||
      typeRaw === "catmull_rom" ||
      typeRaw === "bezier_chain"
        ? typeRaw
        : "unknown";
    const nodesArr = Array.isArray(o.nodes)
      ? o.nodes.map((n) => (typeof n === "number" ? n : Number(n) || 0))
      : [];
    const chainNodes: ParticleCurve["chainNodes"] = [];
    if (o.nodes && typeof o.nodes === "object" && !Array.isArray(o.nodes)) {
      for (const [tk, tv] of Object.entries(asRecord(o.nodes) ?? {})) {
        const t = Number(tk);
        const node = asRecord(tv) ?? {};
        chainNodes.push({
          t: Number.isFinite(t) ? t : 0,
          value: typeof node.value === "number" ? node.value : 0,
          slope: typeof node.slope === "number" ? node.slope : 0,
        });
      }
    }
    out.push({
      name,
      type,
      input: parseExpr(o.input, 0),
      horizontalRange: parseExpr(o.horizontal_range, 1),
      nodes: nodesArr,
      chainNodes,
    });
  }
  return out;
}

function parseShapePoint(raw: unknown): EmitterShape {
  const o = asRecord(raw) ?? {};
  return {
    kind: "point",
    offset: parseVec3(o.offset),
    direction: parseDirection(o.direction),
  };
}

function parseShapeSphere(raw: unknown): EmitterShape {
  const o = asRecord(raw) ?? {};
  return {
    kind: "sphere",
    offset: parseVec3(o.offset),
    radius: parseExpr(o.radius, 1),
    surfaceOnly: Boolean(o.surface_only),
    direction: parseDirection(o.direction),
  };
}

function parseShapeBox(raw: unknown): EmitterShape {
  const o = asRecord(raw) ?? {};
  return {
    kind: "box",
    offset: parseVec3(o.offset),
    halfDimensions: parseVec3(o.half_dimensions, [0.5, 0.5, 0.5]),
    surfaceOnly: Boolean(o.surface_only),
    direction: parseDirection(o.direction),
  };
}

function parseShapeDisc(raw: unknown): EmitterShape {
  const o = asRecord(raw) ?? {};
  return {
    kind: "disc",
    offset: parseVec3(o.offset),
    radius: parseExpr(o.radius, 1),
    planeNormal: parseVec3(o.plane_normal, [0, 1, 0]),
    surfaceOnly: Boolean(o.surface_only),
    direction: parseDirection(o.direction),
  };
}

function parseDirection(
  raw: unknown,
): [MolangExpr, MolangExpr, MolangExpr] | "outwards" | "inwards" {
  if (raw === "outwards" || raw === "inwards") return raw;
  if (typeof raw === "string") {
    const s = raw.toLowerCase();
    if (s === "outwards" || s === "inwards") return s;
  }
  if (Array.isArray(raw)) return parseVec3(raw, [0, 1, 0]);
  return [0, 1, 0];
}

function parseBillboard(raw: unknown): BillboardAppearance {
  const o = asRecord(raw) ?? {};
  const uvObj = asRecord(o.uv) ?? {};
  const size = Array.isArray(o.size)
    ? ([parseExpr(o.size[0], 0.1), parseExpr(o.size[1], 0.1)] as [
        MolangExpr,
        MolangExpr,
      ])
    : ([0.1, 0.1] as [MolangExpr, MolangExpr]);
  let flipbook: FlipbookUv | null = null;
  const fb = asRecord(uvObj.flipbook);
  if (fb) {
    flipbook = {
      baseUV: [
        parseExpr(Array.isArray(fb.base_UV) ? fb.base_UV[0] : 0, 0),
        parseExpr(Array.isArray(fb.base_UV) ? fb.base_UV[1] : 0, 0),
      ],
      sizeUV: [
        parseExpr(Array.isArray(fb.size_UV) ? fb.size_UV[0] : 8, 8),
        parseExpr(Array.isArray(fb.size_UV) ? fb.size_UV[1] : 8, 8),
      ],
      stepUV: [
        parseExpr(Array.isArray(fb.step_UV) ? fb.step_UV[0] : 0, 0),
        parseExpr(Array.isArray(fb.step_UV) ? fb.step_UV[1] : 0, 0),
      ],
      framesPerSecond: parseExpr(fb.frames_per_second, 8),
      maxFrame: parseExpr(fb.max_frame, 1),
      stretchToLifetime: Boolean(fb.stretch_to_lifetime),
      loop: fb.loop !== false,
    };
  }
  return {
    size,
    facingCameraMode:
      typeof o.facing_camera_mode === "string"
        ? o.facing_camera_mode
        : "lookat_xyz",
    textureWidth:
      typeof uvObj.texture_width === "number" ? uvObj.texture_width : 128,
    textureHeight:
      typeof uvObj.texture_height === "number" ? uvObj.texture_height : 128,
    uv: Array.isArray(uvObj.uv)
      ? [parseExpr(uvObj.uv[0], 0), parseExpr(uvObj.uv[1], 0)]
      : null,
    uvSize: Array.isArray(uvObj.uv_size)
      ? [parseExpr(uvObj.uv_size[0], 8), parseExpr(uvObj.uv_size[1], 8)]
      : null,
    flipbook,
  };
}

function parseTinting(raw: unknown): TintColor | null {
  const o = asRecord(raw) ?? {};
  const color = o.color;
  if (Array.isArray(color)) {
    return {
      kind: "rgba",
      channels: [
        parseExpr(color[0], 1),
        parseExpr(color[1], 1),
        parseExpr(color[2], 1),
        parseExpr(color[3], 1),
      ],
    };
  }
  const cObj = asRecord(color);
  if (!cObj) return null;
  if (cObj.gradient && typeof cObj.gradient === "object") {
    const stops: Array<{
      t: number;
      channels: [MolangExpr, MolangExpr, MolangExpr, MolangExpr];
    }> = [];
    for (const [tk, tv] of Object.entries(asRecord(cObj.gradient) ?? {})) {
      const t = Number(tk);
      const ch = Array.isArray(tv) ? tv : [1, 1, 1, 1];
      stops.push({
        t: Number.isFinite(t) ? t : 0,
        channels: [
          parseExpr(ch[0], 1),
          parseExpr(ch[1], 1),
          parseExpr(ch[2], 1),
          parseExpr(ch[3], 1),
        ],
      });
    }
    stops.sort((a, b) => a.t - b.t);
    return {
      kind: "gradient",
      interpolant: parseExpr(cObj.interpolant, 0),
      stops,
    };
  }
  if (Array.isArray(cObj)) {
    return {
      kind: "rgba",
      channels: [
        parseExpr(cObj[0], 1),
        parseExpr(cObj[1], 1),
        parseExpr(cObj[2], 1),
        parseExpr(cObj[3], 1),
      ],
    };
  }
  return null;
}

/**
 * Sample a tint gradient at interpolant `t` (unit interval after eval).
 * Exported for unit tests.
 *
 * @param stops - Sorted gradient stops with evaluated RGBA.
 * @param t - Interpolant in roughly `[0,1]` (extrapolates to ends).
 * @returns RGBA.
 */
export function sampleTintGradient(
  stops: Array<{ t: number; rgba: [number, number, number, number] }>,
  t: number,
): [number, number, number, number] {
  if (stops.length === 0) return [1, 1, 1, 1];
  if (t <= stops[0]!.t) return stops[0]!.rgba;
  const last = stops[stops.length - 1]!;
  if (t >= last.t) return last.rgba;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (t < a.t || t > b.t) continue;
    const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
    return [
      a.rgba[0] * (1 - u) + b.rgba[0] * u,
      a.rgba[1] * (1 - u) + b.rgba[1] * u,
      a.rgba[2] * (1 - u) + b.rgba[2] * u,
      a.rgba[3] * (1 - u) + b.rgba[3] * u,
    ];
  }
  return last.rgba;
}

function parseKillPlane(raw: unknown): [number, number, number, number] | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const n = raw.map((v) => (typeof v === "number" ? v : Number(v)));
  if (n.some((x) => !Number.isFinite(x))) return null;
  return [n[0]!, n[1]!, n[2]!, n[3]!];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}
