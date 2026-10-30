import type { TimedFrame } from "./client";
import { drawnBlockAt } from "./clearance";
import { Store } from "../src/store";

export interface TakeMap {
  /** Binary PPM (P6), one pixel per block, north up. */
  ppm: Buffer;
  /** Top-block counts, most common first. */
  legend: Array<[string, number]>;
}

/**
 * Top-down scouting map of a take's final world: the top drawn block per
 * (x, z), coloured by name and shaded by height (dark = the area's lowest top,
 * bright = its highest). Used to place film cameras
 * (where a build's faces are, what stands in front of them) without a render.
 *
 * ponytail: colours are a hash of the block name, not texture averages;
 * grass, leaves, and water get fixed colours so terrain reads at a glance.
 *
 * @param frames - Take timeline.
 * @param area - Inclusive block bounds `[x0, z0, x1, z1]`.
 * @param yRange - Scan from `yRange[1]` down to `yRange[0]`.
 * @returns PPM bytes and the legend.
 */
export function takeMap(
  frames: readonly TimedFrame[],
  area: [number, number, number, number],
  yRange: [number, number] = [-64, 200],
): TakeMap {
  const store = new Store();
  for (const { frame } of frames) store.apply(frame);
  const s = store.getState();
  const [ax, az, bx, bz] = area;
  const w = bx - ax + 1;
  const h = bz - az + 1;
  const tops: Array<{ i: number; y: number; name: string }> = [];
  const counts = new Map<string, number>();
  for (let z = az; z <= bz; z++)
    for (let x = ax; x <= bx; x++) {
      let y = yRange[1];
      let name: string | null = null;
      for (; y >= yRange[0] && !(name = drawnBlockAt(s, x, y, z)); y--);
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      tops.push({ i: ((z - az) * w + (x - ax)) * 3, y, name });
    }
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of tops) [lo, hi] = [Math.min(lo, t.y), Math.max(hi, t.y)];
  const span = Math.max(1, hi - lo);
  const px = Buffer.alloc(w * h * 3);
  for (const { i, y, name } of tops) {
    const shade = 0.5 + (y - lo) / span;
    const [r, g, b] = colourOf(name);
    px[i] = Math.min(255, r * shade);
    px[i + 1] = Math.min(255, g * shade);
    px[i + 2] = Math.min(255, b * shade);
  }
  return {
    ppm: Buffer.concat([Buffer.from(`P6 ${w} ${h} 255\n`), px]),
    legend: [...counts].sort((a, b) => b[1] - a[1]),
  };
}

function colourOf(name: string): [number, number, number] {
  if (/grass|leaves/.test(name)) return [60, 150, 60];
  if (/water/.test(name)) return [40, 80, 200];
  let n = 0;
  for (const c of name) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return [64 + (n & 127), 64 + ((n >> 7) & 127), 64 + ((n >> 14) & 127)];
}
