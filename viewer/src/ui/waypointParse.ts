/**
 * Waypoint mark messages: `x,y,z|label` (label optional).
 */

/** A waypoint target parsed from a `mark` frame with phase `waypoint`. */
export interface Waypoint {
  x: number;
  y: number;
  z: number;
  label: string;
}

/**
 * Parse a waypoint mark message.
 *
 * @param message - Mark frame message.
 * @returns the waypoint, or null when the message is not parseable.
 */
export function parseWaypoint(message: string): Waypoint | null {
  const [coords, ...labelParts] = message.split("|");
  const nums = (coords ?? "")
    .split(",")
    .map((n) => Number.parseFloat(n.trim()));
  if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n))) return null;
  return {
    x: nums[0]!,
    y: nums[1]!,
    z: nums[2]!,
    label: labelParts.join("|").trim(),
  };
}

/**
 * Bearing from an observer to a target, relative to the observer's yaw.
 *
 * Bedrock yaw: 0° faces +Z, 90° faces −X (clockwise from above), so the
 * facing vector is (−sin yaw, cos yaw).
 *
 * @param pos - Observer position `[x, y, z]`.
 * @param yawDeg - Observer yaw in degrees.
 * @param target - Waypoint target.
 * @returns relative bearing in degrees, (−180, 180]; 0 = ahead, positive = right.
 */
export function relativeBearing(
  pos: [number, number, number],
  yawDeg: number,
  target: Waypoint,
): number {
  const dx = target.x - pos[0];
  const dz = target.z - pos[2];
  const bearing = (Math.atan2(-dx, dz) * 180) / Math.PI;
  let rel = bearing - yawDeg;
  while (rel <= -180) rel += 360;
  while (rel > 180) rel -= 360;
  return rel;
}

/**
 * 3D distance between an observer and a waypoint, rounded for display.
 *
 * @param pos - Observer position `[x, y, z]`.
 * @param target - Waypoint target.
 * @returns whole-block distance.
 */
export function waypointDistance(
  pos: [number, number, number],
  target: Waypoint,
): number {
  const dx = target.x - pos[0];
  const dy = target.y - pos[1];
  const dz = target.z - pos[2];
  return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
}
