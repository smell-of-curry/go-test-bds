import type { Column, DeltaFrame, Frame, KeyframeFrame } from "../src/protocol";

/**
 * Columns kept for film lookahead. 20 chunks is 320 blocks — past a
 * portrait shot, inside a bot's usual receive radius when the camera
 * stays near the action.
 */
export const FILM_LOOKAHEAD_CHUNKS = 20;

export interface LookaheadPoint {
  /** Block coordinate. */
  x: number;
  /** Block coordinate. */
  z: number;
}

export interface TimedFilmFrame {
  tMs: number;
  frame: Frame;
}

export interface LookaheadRewriteOptions {
  /** Start of the rendered window, ms after the first keyframe. */
  fromMs: number;
  /** End of the rendered window, exclusive. */
  toMs: number;
  /**
   * Camera (or actor) positions over the window. Empty falls back to actor
   * poses inside `[fromMs, toMs)`.
   */
  points: readonly LookaheadPoint[];
  /** Chebyshev chunk radius around any point. Default {@link FILM_LOOKAHEAD_CHUNKS}. */
  radiusChunks?: number;
}

interface Generation {
  frames: TimedFilmFrame[];
  /** Seed payload for each `x,z` in this dimension (see {@link betterSeed}). */
  first: Map<string, Column>;
}

/**
 * Chunk Chebyshev distance from a column to any sample.
 *
 * @param x - Column chunk X.
 * @param z - Column chunk Z.
 * @param points - Block-space samples.
 * @param radiusChunks - Inclusive radius.
 * @returns true when the column is inside the bubble.
 */
export function columnNearPoints(
  x: number,
  z: number,
  points: readonly LookaheadPoint[],
  radiusChunks: number,
): boolean {
  for (const p of points) {
    const cx = Math.floor(p.x / 16);
    const cz = Math.floor(p.z / 16);
    if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) <= radiusChunks) {
      return true;
    }
  }
  return false;
}

/**
 * Straight-line samples of an authored track over `[fromSec, toSec]`.
 * `inOutSine` only retimes the same segment, so the samples stay on the path.
 *
 * @param keys - `{t, pos, ease?}` keyframes. `t` is seconds.
 * @param fromSec - Window start.
 * @param toSec - Window end.
 * @returns XZ points, about one every half second.
 */
export function sampleTrackPoints(
  keys: readonly {
    t: number;
    pos: readonly [number, number, number];
    ease?: string;
  }[],
  fromSec: number,
  toSec: number,
): LookaheadPoint[] {
  if (keys.length === 0 || !(toSec >= fromSec)) return [];
  const sorted =
    keys.length === 1 ? keys : keys.slice().sort((a, b) => a.t - b.t);
  const at = (tSec: number): LookaheadPoint => {
    const first = sorted[0]!;
    if (tSec <= first.t) return { x: first.pos[0], z: first.pos[2] };
    const last = sorted[sorted.length - 1]!;
    if (tSec >= last.t) return { x: last.pos[0], z: last.pos[2] };
    let i = 1;
    while (i < sorted.length && sorted[i]!.t < tSec) i++;
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    const span = b.t - a.t;
    let u = span <= 0 ? 1 : (tSec - a.t) / span;
    if (b.ease === "inOutSine") u = (1 - Math.cos(Math.PI * u)) / 2;
    return {
      x: a.pos[0] + (b.pos[0] - a.pos[0]) * u,
      z: a.pos[2] + (b.pos[2] - a.pos[2]) * u,
    };
  };
  const out: LookaheadPoint[] = [];
  for (let t = fromSec; t <= toSec + 1e-9; t += 0.5) out.push(at(t));
  const end = at(toSec);
  const prev = out[out.length - 1];
  if (!prev || prev.x !== end.x || prev.z !== end.z) out.push(end);
  return out;
}

/**
 * Pull columns the bot receives later up to the start of their dimension,
 * but only those within the camera bubble. The object inserted is the column
 * as complete as the wire had it at the window start. Later `columnsAdded` and block edits stay on their
 * real timestamps. In-bubble `columnsRemoved` before `toMs` is dropped so a
 * chunk the bot walked away from does not vanish mid-shot.
 *
 * @param frames - Take timeline, oldest first.
 * @param opts - Window and camera samples.
 * @returns a new frame list. Column object identity is preserved.
 */
export function rewriteTimelineForLookahead(
  frames: readonly TimedFilmFrame[],
  opts: LookaheadRewriteOptions,
): TimedFilmFrame[] {
  const radius = opts.radiusChunks ?? FILM_LOOKAHEAD_CHUNKS;
  const points =
    opts.points.length > 0
      ? opts.points
      : actorPointsInWindow(frames, opts.fromMs, opts.toMs);
  if (points.length === 0) return frames.slice();

  const pre: TimedFilmFrame[] = [];
  const gens: Generation[] = [];
  let current: Generation | null = null;
  for (const item of frames) {
    const frame = item.frame;
    const boundary =
      frame.type === "keyframe" ||
      (frame.type === "delta" && frame.world != null);
    if (boundary) {
      current = { frames: [], first: new Map() };
      gens.push(current);
    }
    if (!current) {
      pre.push(item);
      continue;
    }
    current.frames.push(item);
    const cols = columnsOf(frame);
    if (!cols) continue;
    for (const col of cols) {
      const key = columnId(col.x, col.z);
      const have = current.first.get(key);
      if (!have || betterSeed(have, col, item.tMs, opts.fromMs)) {
        current.first.set(key, col);
      }
    }
  }

  const out: TimedFilmFrame[] = pre.slice();
  for (const gen of gens) {
    const keep = new Map<string, Column>();
    for (const [key, col] of gen.first) {
      if (columnNearPoints(col.x, col.z, points, radius)) keep.set(key, col);
    }
    let seeded = false;
    for (const item of gen.frames) {
      let frame = item.frame;
      if (
        !seeded &&
        (frame.type === "keyframe" ||
          (frame.type === "delta" && frame.world != null))
      ) {
        frame = seedColumns(frame, keep);
        seeded = true;
      }
      if (
        frame.type === "delta" &&
        frame.columnsRemoved &&
        item.tMs < opts.toMs
      ) {
        const removed = frame.columnsRemoved.filter(
          ([x, z]) => !keep.has(columnId(x, z)),
        );
        if (removed.length !== frame.columnsRemoved.length) {
          const next: DeltaFrame = {
            ...frame,
            columnsRemoved: removed.length > 0 ? removed : undefined,
          };
          frame = next;
        }
      }
      out.push(frame === item.frame ? item : { tMs: item.tMs, frame });
    }
  }
  return out;
}

/**
 * Actor feet XZ for frames inside the rendered window.
 *
 * @param frames - Timeline.
 * @param fromMs - Inclusive.
 * @param toMs - Exclusive.
 * @returns one point per actor pose in range.
 */
export function actorPointsInWindow(
  frames: readonly TimedFilmFrame[],
  fromMs: number,
  toMs: number,
): LookaheadPoint[] {
  const out: LookaheadPoint[] = [];
  for (const item of frames) {
    if (item.tMs < fromMs || item.tMs >= toMs) continue;
    const frame = item.frame;
    if (frame.type !== "keyframe" && frame.type !== "delta") continue;
    const actor = frame.actor;
    if (!actor) continue;
    out.push({ x: actor.pos[0], z: actor.pos[2] });
  }
  return out;
}

/**
 * Whether `next` should replace `have` as a column's seed. A column first
 * arrives as an empty `requested` shell and is re-sent whole once its
 * sub-chunks land, often after the shot starts, so seeding the first payload
 * left the ground void. Prefer complete payloads, and among those the latest
 * one before the window opens.
 *
 * @param have - Current seed.
 * @param next - Candidate payload.
 * @param tMs - When `next` arrived.
 * @param fromMs - Window start.
 * @returns true to take `next`.
 */
function betterSeed(
  have: Column,
  next: Column,
  tMs: number,
  fromMs: number,
): boolean {
  if (next.state !== "complete") return false;
  return have.state !== "complete" || tMs < fromMs;
}

function columnId(x: number, z: number): string {
  return `${x},${z}`;
}

function columnsOf(frame: Frame): Column[] | undefined {
  if (frame.type === "keyframe") return frame.columns;
  if (frame.type === "delta") return frame.columnsAdded;
  return undefined;
}

function seedColumns(
  frame: KeyframeFrame | DeltaFrame,
  keep: Map<string, Column>,
): Frame {
  if (frame.type === "keyframe") {
    const have = new Set(frame.columns.map((c) => columnId(c.x, c.z)));
    const extra: Column[] = [];
    for (const [key, col] of keep) if (!have.has(key)) extra.push(col);
    if (extra.length === 0) return frame;
    return { ...frame, columns: [...frame.columns, ...extra] };
  }
  const have = new Set(
    (frame.columnsAdded ?? []).map((c) => columnId(c.x, c.z)),
  );
  const extra: Column[] = [];
  for (const [key, col] of keep) if (!have.has(key)) extra.push(col);
  if (extra.length === 0) return frame;
  return {
    ...frame,
    columnsAdded: [...(frame.columnsAdded ?? []), ...extra],
  };
}
