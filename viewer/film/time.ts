/** A `--from` / `--to` bound. Bare numbers and `s` are seconds; `t` / `tick` are server ticks. */
export interface TimeBound {
  kind: "sec" | "tick";
  value: number;
}

/**
 * Parse `1.5`, `1.5s`, `30t`, or `30tick`.
 *
 * @param raw - CLI token.
 * @returns the bound.
 * @throws when the token is empty or not a finite number.
 */
export function parseBound(raw: string): TimeBound {
  const s = raw.trim().toLowerCase();
  if (!s) throw new Error("empty time");
  let kind: TimeBound["kind"] = "sec";
  let num = s;
  if (s.endsWith("tick")) {
    kind = "tick";
    num = s.slice(0, -4);
  } else if (s.endsWith("t")) {
    kind = "tick";
    num = s.slice(0, -1);
  } else if (s.endsWith("s")) {
    num = s.slice(0, -1);
  }
  const value = Number(num);
  if (!Number.isFinite(value)) throw new Error(`bad time ${raw}`);
  return { kind, value };
}

/**
 * Convert a bound onto the virtual timeline (ms after the first keyframe).
 *
 * Seconds are already relative. Ticks are absolute server ticks:
 * `(tick - firstTick) * 50`.
 *
 * @param bound - Parsed flag.
 * @param firstTick - Tick of the first keyframe.
 * @returns milliseconds, not clamped.
 */
export function boundToMs(bound: TimeBound, firstTick: number): number {
  if (bound.kind === "tick") return Math.round((bound.value - firstTick) * 50);
  return Math.round(bound.value * 1000);
}

/**
 * Output-frame timestamps in the half-open range `[fromMs, toMs)`.
 *
 * Spacing is `round(i * 1000 / fps)` so 60 fps sums to 1000 ms over 60 frames
 * (the Playwright clock advances whole milliseconds).
 *
 * @param fromMs - First frame time.
 * @param toMs - End, exclusive.
 * @param fps - Output frame rate.
 * @returns one timestamp per output frame.
 * @throws when the range covers less than one frame.
 */
export function outputTimes(
  fromMs: number,
  toMs: number,
  fps: number,
): number[] {
  if (!(fps > 0) || !Number.isFinite(fps)) throw new Error(`bad fps ${fps}`);
  if (!(toMs > fromMs)) throw new Error(`empty range ${fromMs}..${toMs}`);
  const n = Math.round(((toMs - fromMs) * fps) / 1000);
  if (n < 1) {
    throw new Error(
      `range ${fromMs}..${toMs} ms at ${fps} fps is under one frame`,
    );
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(fromMs + Math.round((i * 1000) / fps));
  return out;
}
