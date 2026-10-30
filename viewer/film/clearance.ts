import { sampleFilmCamera, type FilmCameraKeyframe } from "../src/camera";
import { columnKey, sectionIndex } from "../src/protocol";
import { Store, type WorldState } from "../src/store";
import type { TimedFrame } from "./client";

/** Blocks the viewer draws nothing for, so a camera inside one still sees. */
const SEE_THROUGH =
  /^minecraft:(air|cave_air|void_air|structure_void|barrier|light_block(_\d+)?)$/;

/** Half-size of the box around the lens that must stay clear (near plane plus slack). */
export const LENS_RADIUS = 0.2;
/** A drawn block this close along the view axis fills the frame. */
export const FACE_DISTANCE = 1.5;
/** Centre and every frame corner blocked this close: the lens is boxed in. */
export const ENCLOSED_DISTANCE = 4;

export interface ClearanceHit {
  tSec: number;
  pos: [number, number, number];
  block: string;
  at: [number, number, number];
}

/**
 * Name of the drawn block at a world cell, or null for air, a see-through
 * block, or a column the take never loaded.
 *
 * @param state - Replayed world.
 * @param x - Block X.
 * @param y - Block Y.
 * @param z - Block Z.
 * @returns block name or null.
 */
export function drawnBlockAt(
  state: WorldState,
  x: number,
  y: number,
  z: number,
): string | null {
  const col = state.columns.get(columnKey(x >> 4, z >> 4));
  const sec = col?.sections.get(y >> 4);
  if (!sec) return null;
  const name =
    sec.palette[sec.indices[sectionIndex(x & 15, y & 15, z & 15)]!]?.name;
  return name && !SEE_THROUGH.test(name) ? name : null;
}

/**
 * Replay a take and report every camera sample whose lens box overlaps a drawn
 * block (the shot then shows the inside of a wall or a face sliced by the near plane).
 *
 * ponytail: one world state at the window end, so blocks placed or broken
 * during the window count as always there. Replay per sample if a shot edits
 * the set it flies through.
 *
 * @param frames - Take timeline.
 * @param keys - Camera track (seconds on the take clock).
 * @param fromSec - Window start.
 * @param toSec - Window end, exclusive.
 * @param fps - Samples per second.
 * @param aspect - Output width / height (corner rays).
 * @returns hits in time order.
 */
export function cameraClearance(
  frames: readonly TimedFrame[],
  keys: readonly FilmCameraKeyframe[],
  fromSec: number,
  toSec: number,
  fps: number,
  aspect: number,
): ClearanceHit[] {
  const store = new Store();
  for (const { tMs, frame } of frames) {
    if (tMs <= toSec * 1000) store.apply(frame);
  }
  const state = store.getState();
  const hits: ClearanceHit[] = [];
  const n = Math.max(1, Math.round((toSec - fromSec) * fps));
  for (let i = 0; i < n; i++) {
    const tSec = fromSec + i / fps;
    const { pos, yaw, pitch, fov } = sampleFilmCamera(keys, tSec);
    const hit =
      lensHit(state, pos) ?? faceHit(state, pos, yaw, pitch, fov, aspect);
    if (hit) hits.push({ tSec, pos, ...hit });
  }
  return hits;
}

/**
 * First drawn block along a Bedrock yaw/pitch ray, within `max` blocks.
 */
function ray(
  state: WorldState,
  pos: [number, number, number],
  yawDeg: number,
  pitchDeg: number,
  max: number,
): { block: string; at: [number, number, number]; d: number } | null {
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  const dir = [
    -Math.sin(y) * Math.cos(p),
    -Math.sin(p),
    Math.cos(y) * Math.cos(p),
  ];
  for (let d = LENS_RADIUS; d <= max; d += 0.1) {
    const at = [0, 1, 2].map((i) => Math.floor(pos[i]! + dir[i]! * d)) as [
      number,
      number,
      number,
    ];
    const block = drawnBlockAt(state, ...at);
    if (block) return { block, at, d };
  }
  return null;
}

/**
 * A wall filling the frame: the centre ray hits within {@link FACE_DISTANCE},
 * or the centre and all four frame-corner rays hit within {@link ENCLOSED_DISTANCE}
 * (the lens is boxed in, e.g. inside a hollow roof).
 */
function faceHit(
  state: WorldState,
  pos: [number, number, number],
  yaw: number,
  pitch: number,
  fov: number,
  aspect: number,
): { block: string; at: [number, number, number] } | null {
  const centre = ray(state, pos, yaw, pitch, ENCLOSED_DISTANCE);
  if (!centre) return null;
  if (centre.d <= FACE_DISTANCE)
    return {
      block: `${centre.block} (${centre.d.toFixed(1)} ahead)`,
      at: centre.at,
    };
  const half = (fov / 2) * 0.8;
  const halfH =
    (Math.atan(Math.tan((half * Math.PI) / 180) * aspect) * 180) / Math.PI;
  for (const [dy, dp] of [
    [-halfH, -half],
    [halfH, -half],
    [-halfH, half],
    [halfH, half],
  ])
    if (!ray(state, pos, yaw + dy!, pitch + dp!, ENCLOSED_DISTANCE))
      return null;
  return { block: `${centre.block} (enclosed)`, at: centre.at };
}

function lensHit(
  state: WorldState,
  pos: [number, number, number],
): { block: string; at: [number, number, number] } | null {
  for (const dx of [-LENS_RADIUS, LENS_RADIUS])
    for (const dy of [-LENS_RADIUS, LENS_RADIUS])
      for (const dz of [-LENS_RADIUS, LENS_RADIUS]) {
        const at: [number, number, number] = [
          Math.floor(pos[0] + dx),
          Math.floor(pos[1] + dy),
          Math.floor(pos[2] + dz),
        ];
        const block = drawnBlockAt(state, ...at);
        if (block) return { block, at };
      }
  return null;
}
