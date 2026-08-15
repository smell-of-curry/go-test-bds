import { expect, test } from "@playwright/test";
import {
  dayCount,
  lerpColour,
  moonPhase,
  NOON_HORIZON,
  NOON_TICKS,
  NOON_ZENITH,
  skyPaletteAt,
  starFieldPositions,
  sunAngleRad,
  sunDirection,
  ticksOfDay,
} from "../src/sky";

test.describe("sky time math", () => {
  test("ticksOfDay wraps absolute time", () => {
    expect(ticksOfDay(6000)).toBe(6000);
    expect(ticksOfDay(30000)).toBe(6000);
    expect(ticksOfDay(-1)).toBe(23999);
  });

  test("noon sun is overhead", () => {
    const a = sunAngleRad(NOON_TICKS);
    expect(a).toBeCloseTo(Math.PI / 2, 5);
    const [, y] = sunDirection(NOON_TICKS);
    expect(y).toBeCloseTo(1, 5);
  });

  test("midnight sun is below horizon", () => {
    const [, y] = sunDirection(18_000);
    expect(y).toBeLessThan(0);
  });

  test("moon phase from day count", () => {
    expect(dayCount(48_000)).toBe(2);
    expect(moonPhase(0)).toBe(0);
    expect(moonPhase(7)).toBe(7);
    expect(moonPhase(8)).toBe(0);
  });

  test("noon palette matches Stage 10b fixed colours", () => {
    const p = skyPaletteAt(NOON_TICKS);
    expect(p.zenith).toBe(NOON_ZENITH);
    expect(p.horizon).toBe(NOON_HORIZON);
    expect(p.stars).toBe(0);
  });

  test("palette lerp mid-blend is between keyframes", () => {
    // Halfway sunrise→noon.
    const p = skyPaletteAt(3000);
    const midZ = lerpColour(0x1a2744, NOON_ZENITH, 0.5);
    expect(p.zenith).toBe(midZ);
    expect(p.stars).toBeGreaterThan(0);
    expect(p.stars).toBeLessThan(0.35);
  });

  test("star field is deterministic", () => {
    const a = starFieldPositions(10, 42);
    const b = starFieldPositions(10, 42);
    expect([...a]).toEqual([...b]);
    expect(a[1]!).toBeGreaterThanOrEqual(0);
  });
});
