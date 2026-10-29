/**
 * Horizontal motion for Molang walk queries and the procedural limb swing.
 *
 * Wire `vel` is blocks per tick (gravity is `0.08`). Vanilla
 * `query.modified_move_speed` is that same scale: `animation.player.move.legs`
 * multiplies it by `57.3`, so a walking player (~4.3 blocks/s → ~0.22
 * blocks/tick) swings tens of degrees, not a full turn.
 *
 * Position deltas are measured in blocks/s, then converted when they feed
 * the query. The procedural walk (`FULL_SWING_SPEED`) stays in blocks/s.
 */

/** Horizontal travel in one frame above this is a teleport, not a step. */
export const TELEPORT_BLOCKS = 4;
/** Exponential smoothing time constant for derived blocks/s. */
export const SPEED_TAU_SEC = 0.15;
/** Server tick rate. Wire velocity is blocks per tick. */
export const TICKS_PER_SEC = 20;

/** Per-entity smoother. */
export interface MoveTrack {
  last: [number, number, number] | null;
  /** Smoothed horizontal speed in blocks/s. */
  smoothed: number;
}

/**
 * @returns a track with no sample yet.
 */
export function createMoveTrack(): MoveTrack {
  return { last: null, smoothed: 0 };
}

/** One frame of horizontal motion. */
export interface MoveSample {
  /** max(wire blocks/s, smoothed position blocks/s). For limb swing. */
  blocksPerSec: number;
  /**
   * `blocksPerSec / 20`, same unit as wire `vel` and
   * `query.modified_move_speed`.
   */
  moveSpeed: number;
  /** Horizontal blocks to add to `modified_distance_moved`. 0 on teleport. */
  distance: number;
  /** Actual position change this frame. `[0,0,0]` before the first sample. */
  delta: [number, number, number];
}

/**
 * Advance a track from the entity's feet.
 *
 * A jump farther than {@link TELEPORT_BLOCKS} adds no distance and clears
 * the smoothed speed. `delta` is still the real position change.
 *
 * @param track - Mutable smoother.
 * @param pos - Current feet position, blocks.
 * @param dtSec - Frame delta seconds.
 * @param vel - Wire velocity, blocks per tick.
 * @returns speed, distance, and the position delta.
 */
export function stepHorizontalMove(
  track: MoveTrack,
  pos: [number, number, number],
  dtSec: number,
  vel: [number, number, number],
): MoveSample {
  const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0;
  let dx = 0;
  let dy = 0;
  let dz = 0;
  let distance = 0;
  if (track.last) {
    dx = pos[0] - track.last[0];
    dy = pos[1] - track.last[1];
    dz = pos[2] - track.last[2];
    const horiz = Math.hypot(dx, dz);
    if (horiz > TELEPORT_BLOCKS) {
      track.smoothed = 0;
    } else {
      const instant = dt > 0 ? horiz / dt : 0;
      const alpha = dt > 0 ? 1 - Math.exp(-dt / SPEED_TAU_SEC) : 1;
      track.smoothed += (instant - track.smoothed) * alpha;
      distance = horiz;
    }
  }
  track.last = [pos[0], pos[1], pos[2]];
  const velBps =
    Math.hypot(
      Number.isFinite(vel[0]) ? vel[0] : 0,
      Number.isFinite(vel[2]) ? vel[2] : 0,
    ) * TICKS_PER_SEC;
  const blocksPerSec = Math.max(velBps, track.smoothed);
  return {
    blocksPerSec,
    moveSpeed: blocksPerSec / TICKS_PER_SEC,
    distance,
    delta: [dx, dy, dz],
  };
}

/**
 * Wrap degrees into `(-180, 180]`.
 *
 * @param deg - Unwrapped degrees.
 * @returns wrapped degrees.
 */
export function wrapDegrees(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** Head-look query inputs from a wire rotation. */
export interface HeadLook {
  /** Body yaw, degrees. `rot[0]`. */
  bodyYaw: number;
  /** Look pitch, degrees. Positive looks down. `rot[1]`. */
  pitch: number;
  /** `headYaw - bodyYaw` wrapped to `(-180, 180]`. */
  yawDelta: number;
  /** `yawDelta` clamped to ±75, matching vanilla `target_y_rotation`. */
  targetYaw: number;
}

/**
 * Bedrock look queries from wire `rot`.
 *
 * `rot` is `[yaw, pitch]` or `[yaw, pitch, headYaw]`. Missing `headYaw`
 * means the head follows the body.
 *
 * @param rot - Wire rotation degrees.
 * @returns pitch and yaw deltas.
 */
export function headLookFromRot(rot: readonly number[]): HeadLook {
  const bodyYaw = Number.isFinite(rot[0]) ? rot[0]! : 0;
  const pitch = Number.isFinite(rot[1]) ? rot[1]! : 0;
  const headYaw = rot.length > 2 && Number.isFinite(rot[2]) ? rot[2]! : bodyYaw;
  const yawDelta = wrapDegrees(headYaw - bodyYaw);
  return {
    bodyYaw,
    pitch,
    yawDelta,
    targetYaw: Math.max(-75, Math.min(75, yawDelta)),
  };
}
