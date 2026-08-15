/**
 * Viewer-side procedural locomotion: a walk cycle driven by horizontal
 * velocity plus a one-shot arm swing driven by the wire `swing` counter
 * (Animate packets recorded by the Go bot).
 *
 * Bedrock packs express movement through nested animation controllers the
 * Stage 9 runtime does not evaluate (e.g. the player's
 * `controller.animation.player.base`), so without this the models stand as
 * statues. Limb bones are matched by common names and get additive X
 * rotations about their own pivots; bones a pack animation already rotated
 * this frame are left alone so real animations always win.
 */

import { emptyBonePose, type BoneAnimPose } from "./animation";

/** Horizontal speed (blocks/s) at which the walk cycle reaches full swing. */
const FULL_SWING_SPEED = 1.5;
/** Phase advance in radians per travelled block (stride length knob). */
const PHASE_PER_BLOCK = 3.5;
/** Max leg swing in degrees at full amplitude. */
const LEG_SWING_DEG = 34;
/** Max arm swing in degrees at full amplitude. */
const ARM_SWING_DEG = 28;
/** One-shot arm swing duration in seconds. */
const SWING_SEC = 0.35;
/** Peak one-shot swing rotation in degrees (arm raises forward/up). */
const SWING_PEAK_DEG = 80;

/** Per-entity mutable locomotion state. */
export interface LocomotionState {
  /** Walk phase in radians (advances with distance travelled). */
  phase: number;
  /** Smoothed swing amplitude 0..1 (eases in/out so poses never jump). */
  amp: number;
  /** Last observed wire swing counter (-1 = unseeded). */
  lastSwingSeq: number;
  /** Seconds since the current one-shot swing started (≥ SWING_SEC = idle). */
  swingAge: number;
}

/**
 * @returns fresh idle locomotion state.
 */
export function createLocomotion(): LocomotionState {
  return { phase: 0, amp: 0, lastSwingSeq: -1, swingAge: SWING_SEC };
}

/**
 * Advance the walk phase / amplitude and the one-shot swing clock.
 *
 * @param st - Mutable state.
 * @param dtSec - Frame delta seconds.
 * @param horizSpeed - Horizontal speed in blocks/s.
 * @param swingSeq - Wire swing counter (increments per arm swing); pass 0
 * when the entity has none.
 */
export function tickLocomotion(
  st: LocomotionState,
  dtSec: number,
  horizSpeed: number,
  swingSeq: number,
): void {
  const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0;
  const speed = Number.isFinite(horizSpeed) ? Math.abs(horizSpeed) : 0;

  const target = Math.min(1, speed / FULL_SWING_SPEED);
  st.amp += (target - st.amp) * Math.min(1, dt * 10);
  if (target === 0 && st.amp < 0.01) st.amp = 0;
  st.phase += Math.min(speed, 6) * dt * PHASE_PER_BLOCK;

  if (swingSeq !== st.lastSwingSeq) {
    // First observation seeds without swinging (entity entering view).
    st.swingAge = st.lastSwingSeq === -1 ? SWING_SEC : 0;
    st.lastSwingSeq = swingSeq;
  } else {
    st.swingAge += dt;
  }
}

/** Limb classification: which limb and which half of the gait cycle. */
export interface LimbClass {
  kind: "arm" | "leg";
  /** +1 or -1: sign of `sin(phase)` for the diagonal gait. */
  phaseSign: 1 | -1;
  /** True for the main (right, else only) arm — receives one-shot swings. */
  side: "left" | "right";
}

/**
 * Classify a bone as a walk-cycle limb by common Bedrock bone names
 * (leftArm/rightArm, leftLeg/rightLeg, leg0…leg3, front/hind left/right legs).
 *
 * @param boneName - Geometry bone name.
 * @returns classification or null for non-limb bones.
 */
export function classifyLimb(boneName: string): LimbClass | null {
  const n = boneName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (n.includes("arm") && !n.includes("armor")) {
    if (n.includes("left")) return { kind: "arm", phaseSign: -1, side: "left" };
    if (n.includes("right"))
      return { kind: "arm", phaseSign: 1, side: "right" };
    return null;
  }
  if (!n.includes("leg")) return null;

  let left: boolean | null = n.includes("left")
    ? true
    : n.includes("right")
      ? false
      : null;
  let front: boolean | null = n.includes("front")
    ? true
    : n.includes("hind") || n.includes("back") || n.includes("rear")
      ? false
      : null;
  const digit = /(\d+)$/.exec(n);
  if (digit && (left === null || front === null)) {
    // Vanilla quadrupeds: leg0..leg3 — parity alternates sides, 0/1 back, 2/3 front.
    const i = Number(digit[1]);
    if (left === null) left = i % 2 === 1;
    if (front === null) front = i >= 2;
  }
  if (left === null) return null;
  // Humanoid (no front/back): left leg leads. Quadruped diagonal gait:
  // left-front strides with right-back.
  const lead = front === null ? left : left === front;
  return {
    kind: "leg",
    phaseSign: lead ? 1 : -1,
    side: left ? "left" : "right",
  };
}

/**
 * Merge procedural walk/swing rotations into an animation pose accumulator.
 * Bones the pack animation already rotated this frame are skipped.
 *
 * @param st - Locomotion state (advanced by {@link tickLocomotion}).
 * @param boneNames - Model bone names.
 * @param poses - Pose accumulator (mutated; keyed by bone name).
 */
export function addLocomotionPoses(
  st: LocomotionState,
  boneNames: Iterable<string>,
  poses: Map<string, BoneAnimPose>,
): void {
  const walk = Math.sin(st.phase) * st.amp;
  const swinging = st.swingAge < SWING_SEC;
  const swingRot = swinging
    ? -Math.sin((st.swingAge / SWING_SEC) * Math.PI) * SWING_PEAK_DEG
    : 0;
  if (walk === 0 && !swinging) return;

  // One-shot swing goes to the right arm, or the left when no right exists.
  let swingArm: string | null = null;
  if (swinging) {
    for (const name of boneNames) {
      const limb = classifyLimb(name);
      if (limb?.kind !== "arm") continue;
      if (limb.side === "right") {
        swingArm = name;
        break;
      }
      swingArm ??= name;
    }
  }

  for (const name of boneNames) {
    const limb = classifyLimb(name);
    if (!limb) continue;
    const existing = poses.get(name);
    if (existing && hasRotation(existing)) continue; // pack animation wins

    const amplitude = limb.kind === "leg" ? LEG_SWING_DEG : ARM_SWING_DEG;
    let rotX = walk * amplitude * limb.phaseSign;
    if (name === swingArm) rotX += swingRot;
    if (rotX === 0) continue;

    const pose = existing ?? emptyBonePose();
    pose.rotation[0] += rotX;
    poses.set(name, pose);
  }
}

/**
 * @param pose - Accumulated pose.
 * @returns true when any rotation channel is non-zero.
 */
function hasRotation(pose: BoneAnimPose): boolean {
  return (
    pose.rotation[0] !== 0 || pose.rotation[1] !== 0 || pose.rotation[2] !== 0
  );
}
