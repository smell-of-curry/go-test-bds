import type { CompiledMolang } from "../molang";

/** Number or compiled Molang (particle JSON allows both). */
export type MolangExpr = number | CompiledMolang;

/** Parsed curve (`variable.*` driven). */
export interface ParticleCurve {
  /** Variable name without `variable.` prefix (lowercase). */
  name: string;
  type: "linear" | "bezier" | "catmull_rom" | "bezier_chain" | "unknown";
  input: MolangExpr;
  horizontalRange: MolangExpr;
  /** Flat node samples (linear / bezier / catmull_rom). */
  nodes: number[];
  /** bezier_chain keyed nodes (t → value/slope). */
  chainNodes: Array<{ t: number; value: number; slope: number }>;
}

export type EmitterRate =
  | { kind: "instant"; numParticles: MolangExpr }
  | { kind: "steady"; spawnRate: MolangExpr; maxParticles: MolangExpr }
  | { kind: "manual"; maxParticles: MolangExpr };

export type EmitterLifetime =
  | { kind: "once"; activeTime: MolangExpr }
  | { kind: "looping"; activeTime: MolangExpr; sleepTime: MolangExpr }
  | {
      kind: "expression";
      activation: MolangExpr | null;
      expiration: MolangExpr | null;
    };

export type EmitterShape =
  | {
      kind: "point";
      offset: [MolangExpr, MolangExpr, MolangExpr];
      direction: [MolangExpr, MolangExpr, MolangExpr] | "outwards" | "inwards";
    }
  | {
      kind: "sphere";
      offset: [MolangExpr, MolangExpr, MolangExpr];
      radius: MolangExpr;
      surfaceOnly: boolean;
      direction: [MolangExpr, MolangExpr, MolangExpr] | "outwards" | "inwards";
    }
  | {
      kind: "box";
      offset: [MolangExpr, MolangExpr, MolangExpr];
      halfDimensions: [MolangExpr, MolangExpr, MolangExpr];
      surfaceOnly: boolean;
      direction: [MolangExpr, MolangExpr, MolangExpr] | "outwards" | "inwards";
    }
  | {
      kind: "disc";
      offset: [MolangExpr, MolangExpr, MolangExpr];
      radius: MolangExpr;
      planeNormal: [MolangExpr, MolangExpr, MolangExpr];
      surfaceOnly: boolean;
      direction: [MolangExpr, MolangExpr, MolangExpr] | "outwards" | "inwards";
    }
  | { kind: "unsupported"; name: string };

export interface FlipbookUv {
  baseUV: [MolangExpr, MolangExpr];
  sizeUV: [MolangExpr, MolangExpr];
  stepUV: [MolangExpr, MolangExpr];
  framesPerSecond: MolangExpr;
  maxFrame: MolangExpr;
  stretchToLifetime: boolean;
  loop: boolean;
}

export interface BillboardAppearance {
  size: [MolangExpr, MolangExpr];
  facingCameraMode: string;
  textureWidth: number;
  textureHeight: number;
  uv: [MolangExpr, MolangExpr] | null;
  uvSize: [MolangExpr, MolangExpr] | null;
  flipbook: FlipbookUv | null;
}

export type TintColor =
  | { kind: "rgba"; channels: [MolangExpr, MolangExpr, MolangExpr, MolangExpr] }
  | {
      kind: "gradient";
      interpolant: MolangExpr;
      stops: Array<{
        t: number;
        channels: [MolangExpr, MolangExpr, MolangExpr, MolangExpr];
      }>;
    };

/** Fully parsed 1.10 `particle_effect` document. */
export interface ParsedParticleEffect {
  identifier: string;
  material: string;
  texture: string;
  curves: ParticleCurve[];
  rate: EmitterRate | null;
  lifetime: EmitterLifetime | null;
  shape: EmitterShape | null;
  particleMaxLifetime: MolangExpr | null;
  initialSpeed: MolangExpr | null;
  initialRotation: MolangExpr | null;
  initialRotationRate: MolangExpr | null;
  motionDynamic: {
    linearAcceleration: [MolangExpr, MolangExpr, MolangExpr];
    linearDrag: MolangExpr;
    rotationAcceleration: MolangExpr;
    rotationDrag: MolangExpr;
  } | null;
  motionParametric: {
    relativePosition: [MolangExpr, MolangExpr, MolangExpr] | null;
    direction: [MolangExpr, MolangExpr, MolangExpr] | null;
  } | null;
  billboard: BillboardAppearance | null;
  tinting: TintColor | null;
  killPlane: [number, number, number, number] | null;
  /** Components present but not simulated (recorded once per effect). */
  unsupportedComponents: string[];
}
