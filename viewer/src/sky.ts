/**
 * Stage 10 sky math — pure functions for time-of-day, palettes, celestial angles.
 * Absent world time → client keeps the fixed noon gradient (goldens unchanged).
 */

/** Bedrock day length in ticks. */
export const DAY_TICKS = 24_000;

/** Noon / midnight in ticks-of-day. */
export const NOON_TICKS = 6_000;
export const MIDNIGHT_TICKS = 18_000;

/** Fixed noon palette matching Stage 10b `SKY_ZENITH` / `SKY_HORIZON`. */
export const NOON_ZENITH = 0x3a6ea5;
export const NOON_HORIZON = 0xa8d4f0;

export interface SkyPalette {
  zenith: number;
  horizon: number;
  fog: number;
  /** Ambient light intensity 0..1. */
  ambient: number;
  /** Directional (sun) light intensity 0..1. */
  sun: number;
  /** Star opacity 0..1. */
  stars: number;
}

/** Day / sunset / night / sunrise keyframes (ticks-of-day → palette). */
export const SKY_KEYFRAMES: ReadonlyArray<{ t: number; p: SkyPalette }> = [
  {
    // Sunrise ~0
    t: 0,
    p: {
      zenith: 0x1a2744,
      horizon: 0xff8a5c,
      fog: 0xff8a5c,
      ambient: 0.35,
      sun: 0.45,
      stars: 0.35,
    },
  },
  {
    // Noon
    t: NOON_TICKS,
    p: {
      zenith: NOON_ZENITH,
      horizon: NOON_HORIZON,
      fog: NOON_HORIZON,
      ambient: 0.55,
      sun: 0.85,
      stars: 0,
    },
  },
  {
    // Sunset ~12000
    t: 12_000,
    p: {
      zenith: 0x2a3a6a,
      horizon: 0xff6b3d,
      fog: 0xff6b3d,
      ambient: 0.32,
      sun: 0.4,
      stars: 0.2,
    },
  },
  {
    // Midnight
    t: MIDNIGHT_TICKS,
    p: {
      zenith: 0x050814,
      horizon: 0x0a1028,
      fog: 0x0a1028,
      ambient: 0.12,
      sun: 0.05,
      stars: 1,
    },
  },
];

/**
 * Absolute world time → ticks-of-day in `[0, 24000)`.
 *
 * @param time - Absolute ticks from SetTime.
 * @returns ticks-of-day.
 */
export function ticksOfDay(time: number): number {
  const t = ((time % DAY_TICKS) + DAY_TICKS) % DAY_TICKS;
  return t;
}

/**
 * Day index for moon phase (`floor(time / 24000)`).
 *
 * @param time - Absolute ticks.
 * @returns non-negative day count.
 */
export function dayCount(time: number): number {
  return Math.floor(time / DAY_TICKS);
}

/**
 * Moon phase index 0..7 from day count.
 *
 * @param day - Day count.
 * @returns phase 0..7.
 */
export function moonPhase(day: number): number {
  return ((day % 8) + 8) % 8;
}

/**
 * Sun elevation angle in radians. 0 at sunrise, π/2 at noon, π at sunset,
 * negative below horizon at night. Matches Bedrock day cycle (noon = 6000).
 *
 * @param tod - Ticks-of-day `[0, 24000)`.
 * @returns sun angle radians from eastern horizon.
 */
export function sunAngleRad(tod: number): number {
  // Map ticks so noon (6000) → π/2 (overhead).
  return ((tod - NOON_TICKS) / DAY_TICKS) * Math.PI * 2 + Math.PI / 2;
}

/**
 * Unit direction toward the sun (Y-up). Positive Y = above horizon.
 *
 * @param tod - Ticks-of-day.
 * @returns `[x, y, z]` unit vector.
 */
export function sunDirection(tod: number): [number, number, number] {
  const a = sunAngleRad(tod);
  // Orbit in the X/Y plane (east→zenith→west); Z=0.
  return [Math.cos(a), Math.sin(a), 0];
}

/**
 * Moon direction — opposite the sun on the same orbit.
 *
 * @param tod - Ticks-of-day.
 * @returns `[x, y, z]` unit vector.
 */
export function moonDirection(tod: number): [number, number, number] {
  const [x, y, z] = sunDirection(tod);
  return [-x, -y, -z];
}

function lerpChan(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hexToRgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function rgbToHex(r: number, g: number, b: number): number {
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

/**
 * Lerp two packed RGB colours.
 *
 * @param a - Start `0xRRGGBB`.
 * @param b - End `0xRRGGBB`.
 * @param t - Blend `[0,1]`.
 * @returns lerped colour.
 */
export function lerpColour(a: number, b: number, t: number): number {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(
    lerpChan(ar, br, t),
    lerpChan(ag, bg, t),
    lerpChan(ab, bb, t),
  );
}

/**
 * Interpolate sky palette across the four day/sunset/night/sunrise keyframes.
 *
 * @param tod - Ticks-of-day.
 * @returns blended palette.
 */
export function skyPaletteAt(tod: number): SkyPalette {
  const t = ticksOfDay(tod);
  const frames = SKY_KEYFRAMES;
  // Wrap: after last keyframe, lerp toward first + 24000.
  let i = 0;
  for (; i < frames.length - 1; i++) {
    if (t < frames[i + 1]!.t) break;
  }
  const a = frames[i]!;
  const b = frames[(i + 1) % frames.length]!;
  const bT = i + 1 >= frames.length ? b.t + DAY_TICKS : b.t;
  const aT = a.t;
  const span = bT - aT;
  const u = span <= 0 ? 0 : (t - aT) / span;
  const tt = Math.min(1, Math.max(0, u));
  return {
    zenith: lerpColour(a.p.zenith, b.p.zenith, tt),
    horizon: lerpColour(a.p.horizon, b.p.horizon, tt),
    fog: lerpColour(a.p.fog, b.p.fog, tt),
    ambient: lerpChan(a.p.ambient, b.p.ambient, tt),
    sun: lerpChan(a.p.sun, b.p.sun, tt),
    stars: lerpChan(a.p.stars, b.p.stars, tt),
  };
}

/** Mulberry32 — deterministic unit floats for star field. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded star directions on the unit sphere (upper hemisphere bias).
 *
 * @param count - Number of stars.
 * @param seed - RNG seed.
 * @returns flat `[x,y,z,…]` positions at radius 1.
 */
export function starFieldPositions(count: number, seed = 0x5c15): Float32Array {
  const rand = mulberry32(seed);
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Uniform on sphere via gaussian-ish rejection on cube, then normalize;
    // bias Y positive so more stars in the night sky dome.
    let x = rand() * 2 - 1;
    let y = rand(); // [0,1] upper
    let z = rand() * 2 - 1;
    const len = Math.hypot(x, y, z) || 1;
    out[i * 3] = x / len;
    out[i * 3 + 1] = y / len;
    out[i * 3 + 2] = z / len;
  }
  return out;
}
