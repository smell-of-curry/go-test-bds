export type Vec3 = [number, number, number];
export type Pos = { x: number; y: number; z: number };
export type Rotation = { yaw: number; pitch: number };
export type Face = 0 | 1 | 2 | 3 | 4 | 5;
export type MovementInput = {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sneak: boolean;
};
