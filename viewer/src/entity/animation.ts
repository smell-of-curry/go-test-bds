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
import { bedrockMatrixToThree, boneLocalMatrix, type Vec3 } from "../geometry";
import type {
  AnimBoneChannels,
  AnimChannel,
  ChannelExpr,
  ParsedAnimation,
} from "./parseAnimation";

/** Rest-pose bone data stashed on each THREE group's userData (JSON-safe). */
export interface BoneRestPose {
  /** Bone pivot in Bedrock model units. */
  pivot: Vec3;
  /** Rest rotation, extrinsic XYZ degrees. */
  rotation: Vec3;
  /** Optional bind-pose rotation (legacy 1.8 geometry). */
  bindPoseRotation?: Vec3;
}

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
 * Apply accumulated poses onto Stage-7 bone groups.
 *
 * Rotations/scales are composed **about each bone's pivot** in Bedrock model
 * space (`T(p)·R(rest+anim)·S·T(-p)`), matching Blockbench/vanilla: animation
 * rotation adds to the rest rotation per axis and swings the bone around its
 * pivot, never the model origin. Animation position is Bedrock model units.
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
  const head = bones.get("head") ?? bones.get("Head");
  for (const [name, group] of bones) {
    const pose = poses.get(name) ?? emptyBonePose();
    const extraPitch = group === head ? headPitchDeg : 0;
    setBoneLocalPose(group, pose, extraPitch);
  }
}

/**
 * Rebuild one bone group's local matrix from its rest pose plus an additive
 * animation pose, rotating about the bone pivot.
 *
 * Falls back to the stored rest matrix when the group carries no
 * {@link BoneRestPose} (models built before Stage 7 stashed it).
 *
 * @param group - Bone THREE group (userData.bedrockPose from buildEntityModel).
 * @param pose - Additive animation pose.
 * @param extraPitchDeg - Extra X rotation degrees (head look pitch).
 */
export function setBoneLocalPose(
  group: THREE.Group,
  pose: BoneAnimPose,
  extraPitchDeg = 0,
): void {
  const rest = group.userData.bedrockPose as BoneRestPose | undefined;
  ensureRestMatrix(group);
  if (!rest) {
    // No pivot data — keep the rest matrix (never rotate about the origin).
    group.matrix.copy(group.userData.restMatrix as THREE.Matrix4);
    group.matrixWorldNeedsUpdate = true;
    return;
  }

  const rotation: Vec3 = [
    rest.rotation[0] + pose.rotation[0] + extraPitchDeg,
    rest.rotation[1] + pose.rotation[1],
    rest.rotation[2] + pose.rotation[2],
  ];
  let local = boneLocalMatrix(
    rest.pivot,
    rotation,
    rest.bindPoseRotation,
    pose.scale,
  );
  if (
    pose.position[0] !== 0 ||
    pose.position[1] !== 0 ||
    pose.position[2] !== 0
  ) {
    local = new THREE.Matrix4()
      .makeTranslation(pose.position[0], pose.position[1], pose.position[2])
      .multiply(local);
  }
  group.matrix.copy(bedrockMatrixToThree(local));
  group.matrixWorldNeedsUpdate = true;
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
