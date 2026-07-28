import type { Actor, Entity } from "./protocol";

/**
 * Smooth poses between successive snapshots. Block data is never interpolated —
 * only actor/entity `pos` / `eyePos` / `rot`.
 *
 * On each snapshot arrival we animate from the currently displayed pose to the
 * new one over the previous inter-arrival span (clamped), so a recording plays
 * as motion rather than a pose slideshow.
 */
export class MotionLerp {
  private actorFrom: Actor | null = null;
  private actorTo: Actor | null = null;
  private entitiesFrom = new Map<number, Entity>();
  private entitiesTo = new Map<number, Entity>();
  private startMs = 0;
  private durationMs = 50;
  private lastArrivalMs = 0;
  private hasSample = false;

  /**
   * Begin a new interpolation toward `actor` / `entities`.
   *
   * @param actor - Latest actor snapshot, or null.
   * @param entities - Latest entity map.
   * @param snap - When true, jump with no blend (keyframe / dimension wipe).
   */
  push(actor: Actor | null, entities: Map<number, Entity>, snap = false): void {
    const now = performance.now();
    if (snap || !this.hasSample) {
      this.actorFrom = actor;
      this.actorTo = actor;
      this.entitiesFrom = cloneEntityMap(entities);
      this.entitiesTo = cloneEntityMap(entities);
      this.startMs = now;
      this.durationMs = 0;
      this.lastArrivalMs = now;
      this.hasSample = true;
      return;
    }

    const displayedActor = this.sampleActor();
    const displayedEntities = this.sampleEntities();
    const span =
      this.lastArrivalMs > 0 ? now - this.lastArrivalMs : this.durationMs;
    this.durationMs = Math.max(16, Math.min(250, span || 50));
    this.actorFrom = displayedActor ?? actor;
    this.actorTo = actor;
    this.entitiesFrom = displayedEntities;
    this.entitiesTo = cloneEntityMap(entities);
    this.startMs = now;
    this.lastArrivalMs = now;
  }

  /** Reset on stream teardown / schema refusal. */
  clear(): void {
    this.actorFrom = null;
    this.actorTo = null;
    this.entitiesFrom.clear();
    this.entitiesTo.clear();
    this.hasSample = false;
  }

  /**
   * @returns actor pose blended for the current wall clock, or null.
   */
  sampleActor(): Actor | null {
    if (!this.actorTo) return null;
    if (!this.actorFrom || this.durationMs <= 0) return this.actorTo;
    return lerpActor(this.actorFrom, this.actorTo, this.alpha());
  }

  /**
   * @returns entity poses blended for the current wall clock.
   */
  sampleEntities(): Map<number, Entity> {
    if (this.durationMs <= 0 || this.entitiesFrom.size === 0) {
      return cloneEntityMap(this.entitiesTo);
    }
    const a = this.alpha();
    const out = new Map<number, Entity>();
    for (const [rid, to] of this.entitiesTo) {
      const from = this.entitiesFrom.get(rid);
      out.set(rid, from ? lerpEntity(from, to, a) : to);
    }
    return out;
  }

  private alpha(): number {
    if (this.durationMs <= 0) return 1;
    return Math.min(
      1,
      Math.max(0, (performance.now() - this.startMs) / this.durationMs),
    );
  }
}

/**
 * @param a - Blend factor in `[0, 1]`.
 * @returns linear interpolation of `x` toward `y`.
 */
function lerp(x: number, y: number, a: number): number {
  return x + (y - x) * a;
}

/**
 * Shortest-path lerp for yaw-like degrees.
 *
 * @param from - Start angle in degrees.
 * @param to - End angle in degrees.
 * @param a - Blend factor in `[0, 1]`.
 * @returns interpolated degrees (not normalised to a fixed range).
 */
function lerpAngle(from: number, to: number, a: number): number {
  let d = to - from;
  d = ((((d + 180) % 360) + 360) % 360) - 180;
  return from + d * a;
}

/**
 * @param from - Start actor pose.
 * @param to - End actor pose.
 * @param a - Blend factor in `[0, 1]`.
 * @returns a shallow copy of `to` with lerped pose fields.
 */
function lerpActor(from: Actor, to: Actor, a: number): Actor {
  if (a >= 1) return to;
  if (a <= 0) return from;
  return {
    ...to,
    pos: [
      lerp(from.pos[0], to.pos[0], a),
      lerp(from.pos[1], to.pos[1], a),
      lerp(from.pos[2], to.pos[2], a),
    ],
    eyePos: [
      lerp(from.eyePos[0], to.eyePos[0], a),
      lerp(from.eyePos[1], to.eyePos[1], a),
      lerp(from.eyePos[2], to.eyePos[2], a),
    ],
    rot: [
      lerpAngle(from.rot[0], to.rot[0], a),
      lerp(from.rot[1], to.rot[1], a),
      ...(to.rot.length > 2
        ? [lerpAngle(from.rot[2] ?? from.rot[0], to.rot[2]!, a)]
        : []),
    ] as Actor["rot"],
  };
}

/**
 * @param from - Start entity pose.
 * @param to - End entity pose.
 * @param a - Blend factor in `[0, 1]`.
 * @returns a shallow copy of `to` with lerped pose fields.
 */
function lerpEntity(from: Entity, to: Entity, a: number): Entity {
  if (a >= 1) return to;
  if (a <= 0) return from;
  return {
    ...to,
    pos: [
      lerp(from.pos[0], to.pos[0], a),
      lerp(from.pos[1], to.pos[1], a),
      lerp(from.pos[2], to.pos[2], a),
    ],
    rot: [
      lerpAngle(from.rot[0], to.rot[0], a),
      lerp(from.rot[1], to.rot[1], a),
      ...(to.rot.length > 2
        ? [lerpAngle(from.rot[2] ?? from.rot[0], to.rot[2]!, a)]
        : []),
    ] as Entity["rot"],
  };
}

/**
 * @param entities - Source map.
 * @returns shallow-cloned map (entity object references preserved).
 */
function cloneEntityMap(entities: Map<number, Entity>): Map<number, Entity> {
  return new Map(entities);
}
