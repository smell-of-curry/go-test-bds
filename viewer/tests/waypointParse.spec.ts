/**
 * Node-only tests for waypoint mark parsing.
 */
import { expect, test } from "@playwright/test";

import {
  parseWaypoint,
  relativeBearing,
  waypointDistance,
} from "../src/ui/waypointParse";

test("parseWaypoint reads x,y,z and an optional label", () => {
  expect(parseWaypoint("1, 2, -3|home")).toEqual({
    x: 1,
    y: 2,
    z: -3,
    label: "home",
  });
  expect(parseWaypoint("nope")).toBeNull();
});

test("relativeBearing is zero when the target is straight ahead", () => {
  // Yaw 0 faces +Z.
  const bearing = relativeBearing([0, 0, 0], 0, {
    x: 0,
    y: 0,
    z: 10,
    label: "",
  });
  expect(Math.abs(bearing)).toBeLessThan(0.01);
});

test("waypointDistance rounds 3D distance", () => {
  expect(waypointDistance([0, 0, 0], { x: 3, y: 4, z: 0, label: "" })).toBe(5);
});
