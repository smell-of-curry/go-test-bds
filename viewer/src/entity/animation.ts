/**
 * Animation channel sampling and bone-transform application.
 *
 * Keyframe rules (MS Learn Animations Overview + actor_animation 1.8.0):
 * - Continuous keys: plain `[x,y,z]` → pre = post = value; linear between.
 * - Discontinuous: `pre` used arriving at the stamp, `post` leaving it.
 * - Segment between k_i.post → k_{i+1}.pre; lerp_mode on the *end* key selects
 *   linear vs catmullrom (schema name; Blockbench may write `"smooth"`).
 * - Catmull-Rom control points use each key's **post** value (Blockbench #1417:
 *   pre is for the linear approach into a catmullrom key after a linear key).
 *
 * Bone channels are additive across animations: sum position/rotation per axis,
 * multiply scales (identity 1). Applied on top of the rest-pose matrix Stage 7
 * baked into each THREE bone group.
 */

import * as THREE from "three";
import { evaluate, type MolangHost } from "../molang";
import { asNumber } from "../molang/value";
import { MODEL_UNITS_PER_BLOCK } from "../geometry";
import type {
  AnimBoneChannels,
  AnimChannel,
  ChannelExpr,
  ParsedAnimation,
} from "./parseAnimation";

/** Accumulated additive pose for one bone (model units / degrees). */
export interface BoneAnimPose {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  /** When true, reset bone to bind before applying (override_previous). */
  override: boolean;
}

/**
 * Create an empty (identity) additive pose.
 *
 * @returns zero translation/rotation, unit scale.
 */
export function emptyBonePose(): BoneAnimPose {
  return {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    override: false,
  };
}

/**
 * Sample one animation at `animTime` into an accumulator map.
 *
 * @param anim - Parsed animation.
 * @param animTime - Current animation time (seconds or distance, per update expr).
 * @param weight - Blend weight in `[0, ∞)` (clamped at apply).
 * @param host - Molang host (channel expressions, blend_weight already applied by caller).
 * @param out - Bone name → pose accumulator (mutated).
 */
export function sampleAnimation(
  anim: ParsedAnimation,
  animTime: number,
  weight: number,
  host: MolangHost,
  out: Map<string, BoneAnimPose>,
): void {
  if (weight === 0 || !Number.isFinite(weight)) return;
  const t = resolveSampleTime(anim, animTime);
  if (t === null) return; // stopped (loop false, past end)

  for (const [bone, channels] of anim.bones) {
    let pose = out.get(bone);
    if (!pose) {
      pose = emptyBonePose();
      out.set(bone, pose);
    }
    if (anim.overridePrevious) pose.override = true;

    if (channels.position) {
      const v = sampleChannel(channels.position, t, host, [0, 0, 0]);
      pose.position[0] += v[0] * weight;
      pose.position[1] += v[1] * weight;
      pose.position[2] += v[2] * weight;
    }
    if (channels.rotation) {
      const v = sampleChannel(channels.rotation, t, host, [0, 0, 0]);
      pose.rotation[0] += v[0] * weight;
      pose.rotation[1] += v[1] * weight;
      pose.rotation[2] += v[2] * weight;
    }
    if (channels.scale) {
      const v = sampleChannel(channels.scale, t, host, [1, 1, 1]);
      // Blend scale toward identity: s' = lerp(1, s, weight) then multiply.
      pose.scale[0] *= 1 + (v[0] - 1) * weight;
      pose.scale[1] *= 1 + (v[1] - 1) * weight;
      pose.scale[2] *= 1 + (v[2] - 1) * weight;
    }
  }
}

/**
 * Resolve the time used for sampling given loop mode.
 *
 * @param anim - Animation.
 * @param animTime - Raw time from anim_time_update.
 * @returns sample time, or null when the animation has stopped.
 */
export function resolveSampleTime(
  anim: ParsedAnimation,
  animTime: number,
): number | null {
  const len = anim.animationLength;
  if (!(len > 0)) return Math.max(0, animTime);

  if (anim.loop === true) {
    // Wrap into [0, len). Exact len → 0.
    const m = animTime % len;
    return m < 0 ? m + len : m;
  }
  if (anim.loop === "hold_on_last_frame") {
    return Math.min(Math.max(0, animTime), len);
  }
  // loop false: play once; past end → stop contributing (MS: "stop").
  if (animTime > len) return null;
  return Math.max(0, animTime);
}

/**
 * Whether a non-looping animation has finished at `animTime`.
 *
 * @param anim - Animation.
 * @param animTime - Current time.
 * @returns true when finished (looping never finishes).
 */
export function isAnimationFinished(
  anim: ParsedAnimation,
  animTime: number,
): boolean {
  if (anim.loop === true) return false;
  const len = anim.animationLength;
  if (!(len > 0)) return animTime > 0;
  return animTime >= len;
}

/**
 * Sample a channel at time t.
 *
 * @param channel - Channel.
 * @param t - Sample time.
 * @param host - Molang host.
 * @param identity - Default when channel empty.
 * @returns XYZ numbers.
 */
export function sampleChannel(
  channel: AnimChannel,
  t: number,
  host: MolangHost,
  identity: [number, number, number],
): [number, number, number] {
  if (channel.constant) {
    return evalTriple(channel.constant, host);
  }
  const kfs = channel.keyframes;
  if (kfs.length === 0) return identity;
  if (kfs.length === 1) {
    // Single key: hold its post (or pre if at exact stamp from the left).
    return evalTriple(kfs[0]!.post, host);
  }

  if (t <= kfs[0]!.time) {
    return evalTriple(kfs[0]!.pre, host);
  }
  const last = kfs[kfs.length - 1]!;
  if (t >= last.time) {
    return evalTriple(last.post, host);
  }

  // Find segment kfs[i] → kfs[i+1] where t in (kfs[i].time, kfs[i+1].time].
  let i = 0;
  for (; i < kfs.length - 1; i++) {
    if (t <= kfs[i + 1]!.time) break;
  }
  const a = kfs[i]!;
  const b = kfs[i + 1]!;
  const span = b.time - a.time;
  const u = span > 0 ? (t - a.time) / span : 1;

  const from = evalTriple(a.post, host);
  const to = evalTriple(b.pre, host);

  if (b.lerpMode === "catmullrom") {
    const p0 = evalTriple((kfs[i - 1] ?? a).post, host);
    const p1 = from;
    const p2 = to;
    const p3 = evalTriple((kfs[i + 2] ?? b).post, host);
    return [
      catmullRom(p0[0], p1[0], p2[0], p3[0], u),
      catmullRom(p0[1], p1[1], p2[1], p3[1], u),
      catmullRom(p0[2], p1[2], p2[2], p3[2], u),
    ];
  }

  return [
    from[0] + (to[0] - from[0]) * u,
    from[1] + (to[1] - from[1]) * u,
    from[2] + (to[2] - from[2]) * u,
  ];
}

/**
 * Uniform Catmull-Rom spline (tension 0.5), t in [0,1] between p1 and p2.
 *
 * @param p0 - Previous control.
 * @param p1 - Segment start.
 * @param p2 - Segment end.
 * @param p3 - Next control.
 * @param t - Parameter.
 * @returns interpolated value.
 */
export function catmullRom(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Apply accumulated poses onto Stage-7 bone groups (rest matrix in userData).
 *
 * Animation position is Bedrock model units (÷16, X flipped) — same as geometry.
 * Rotation is additive extrinsic XYZ degrees after rest.
 *
 * @param bones - Bone name → THREE group.
 * @param poses - Accumulated additive poses.
 * @param headPitchDeg - Optional look pitch applied to head bone after anim.
 */
export function applyBonePoses(
  bones: Map<string, THREE.Group>,
  poses: Map<string, BoneAnimPose>,
  headPitchDeg = 0,
): void {
  for (const [name, group] of bones) {
    ensureRestMatrix(group);
    const rest = group.userData.restMatrix as THREE.Matrix4;
    const pose = poses.get(name) ?? emptyBonePose();

    // Bedrock → three translation (geometry/math.ts bedrockToThree).
    const tx = -pose.position[0] / MODEL_UNITS_PER_BLOCK;
    const ty = pose.position[1] / MODEL_UNITS_PER_BLOCK;
    const tz = pose.position[2] / MODEL_UNITS_PER_BLOCK;

    const deg = Math.PI / 180;
    // Extrinsic XYZ = intrinsic ZYX Euler (same as geometry/math.ts).
    const rot = new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(
        pose.rotation[0] * deg,
        pose.rotation[1] * deg,
        pose.rotation[2] * deg,
        "ZYX",
      ),
    );
    const scl = new THREE.Matrix4().makeScale(
      pose.scale[0],
      pose.scale[1],
      pose.scale[2],
    );
    const tr = new THREE.Matrix4().makeTranslation(tx, ty, tz);

    // Local = rest * T * R * S  (docs: translate, then rotate, then scale on verts;
    // for bone local TRS we compose anim after rest bind).
    group.matrix.copy(rest).multiply(tr).multiply(rot).multiply(scl);
    group.matrixWorldNeedsUpdate = true;
  }

  if (headPitchDeg !== 0) {
    const head = bones.get("head") ?? bones.get("Head");
    if (head) {
      const pitch = THREE.MathUtils.degToRad(headPitchDeg);
      const pitchMat = new THREE.Matrix4().makeRotationX(pitch);
      head.matrix.multiply(pitchMat);
      head.matrixWorldNeedsUpdate = true;
    }
  }
}

/**
 * Reset bones to rest pose (no animation).
 *
 * @param bones - Bone map.
 */
export function resetBonesToRest(bones: Map<string, THREE.Group>): void {
  for (const group of bones.values()) {
    ensureRestMatrix(group);
    group.matrix.copy(group.userData.restMatrix as THREE.Matrix4);
    group.matrixWorldNeedsUpdate = true;
  }
}

/**
 * Seed / read the rest-pose local matrix stored on a bone group.
 *
 * @param group - Bone THREE group.
 */
export function ensureRestMatrix(group: THREE.Group): void {
  if (!group.userData.restMatrix) {
    group.userData.restMatrix = group.matrix.clone();
  }
}

/**
 * Evaluate a channel triple through Molang.
 *
 * @param triple - Expressions.
 * @param host - Host.
 * @returns numbers.
 */
function evalTriple(
  triple: [ChannelExpr, ChannelExpr, ChannelExpr],
  host: MolangHost,
): [number, number, number] {
  return [
    evalExpr(triple[0], host),
    evalExpr(triple[1], host),
    evalExpr(triple[2], host),
  ];
}

/**
 * @param expr - Number or Molang.
 * @param host - Host.
 * @returns number.
 */
function evalExpr(expr: ChannelExpr, host: MolangHost): number {
  if (typeof expr === "number") return expr;
  try {
    return asNumber(evaluate(expr, host));
  } catch {
    return 0;
  }
}

/**
 * Advance anim_time via `anim_time_update` (default `query.anim_time + query.delta_time`).
 *
 * @param anim - Animation.
 * @param animTime - Current time.
 * @param host - Host with query.anim_time / query.delta_time set.
 * @returns next anim_time.
 */
export function advanceAnimTime(
  anim: ParsedAnimation,
  animTime: number,
  host: MolangHost,
): number {
  const src = anim.animTimeUpdate ?? "query.anim_time + query.delta_time";
  try {
    return asNumber(evaluate(src, host));
  } catch {
    return animTime;
  }
}

/**
 * Sample bone channels for tests (single anim, weight 1).
 *
 * @param anim - Animation.
 * @param animTime - Time.
 * @param host - Host.
 * @returns bone → pose.
 */
export function sampleAnimationPoses(
  anim: ParsedAnimation,
  animTime: number,
  host: MolangHost,
): Map<string, BoneAnimPose> {
  const out = new Map<string, BoneAnimPose>();
  sampleAnimation(anim, animTime, 1, host, out);
  return out;
}

/** Re-export bone channel type for tests. */
export type { AnimBoneChannels, ParsedAnimation };
