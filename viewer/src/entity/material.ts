import * as THREE from "three";
import { compile, type MolangValue } from "../molang";
import { createEntityMolangHost } from "./queries";
import type { EntityRenderInputs, RenderControllerColor } from "./types";

/** Transparency mode for entity skins. */
export type TransparencyMode = "opaque" | "alpha_test" | "blend";

/** Render-state derived from a Bedrock material name. */
export interface MaterialRenderState {
  transparency: TransparencyMode;
  /** When true, cull back faces (FrontSide). */
  cull: boolean;
  /** Fullbright — ignore scene lighting (MeshBasicMaterial is already unlit). */
  emissive: boolean;
  /** Alpha-test threshold when transparency === alpha_test. */
  alphaTest: number;
}

/** Default cutout used by most entity skins (transparent texels discarded). */
export const DEFAULT_ENTITY_MATERIAL: MaterialRenderState = {
  transparency: "alpha_test",
  cull: true,
  emissive: false,
  alphaTest: 0.5,
};

/**
 * Exact / substring table established empirically from bedrock-samples entity
 * defs (materials/ is absent). See entity/README.md.
 */
const EXACT: Record<string, MaterialRenderState> = {
  entity: {
    transparency: "opaque",
    cull: true,
    emissive: false,
    alphaTest: 0,
  },
  entity_static: {
    transparency: "opaque",
    cull: true,
    emissive: false,
    alphaTest: 0,
  },
  entity_alphatest: {
    transparency: "alpha_test",
    cull: true,
    emissive: false,
    alphaTest: 0.5,
  },
  entity_alphablend: {
    transparency: "blend",
    cull: true,
    emissive: false,
    alphaTest: 0,
  },
  entity_emissive: {
    transparency: "opaque",
    cull: true,
    emissive: true,
    alphaTest: 0,
  },
  entity_emissive_alpha: {
    transparency: "alpha_test",
    cull: false,
    emissive: true,
    alphaTest: 0.5,
  },
  entity_emissive_alpha_one_sided: {
    transparency: "alpha_test",
    cull: true,
    emissive: true,
    alphaTest: 0.5,
  },
  entity_nocull: {
    transparency: "opaque",
    cull: false,
    emissive: false,
    alphaTest: 0,
  },
  charged_creeper: {
    transparency: "blend",
    cull: false,
    emissive: true,
    alphaTest: 0,
  },
  slime_outer: {
    transparency: "blend",
    cull: false,
    emissive: false,
    alphaTest: 0,
  },
  spider: {
    transparency: "alpha_test",
    cull: true,
    emissive: true,
    alphaTest: 0.5,
  },
  enderman: {
    transparency: "alpha_test",
    cull: true,
    emissive: true,
    alphaTest: 0.5,
  },
};

/**
 * Map a Bedrock material name to viewer render state.
 *
 * Unknown short names (sheep, zombie, armor_stand, …) default to alphatest
 * cutout — that matches observed vanilla skin behaviour.
 *
 * @param name - Material id from client entity / RC (e.g. `entity_alphatest`).
 * @returns render state.
 */
export function materialStateFromName(name: string): MaterialRenderState {
  const key = name.trim().toLowerCase();
  if (!key) return { ...DEFAULT_ENTITY_MATERIAL };

  const exact = EXACT[key];
  if (exact) return { ...exact };

  // Pattern fallbacks for derived / pack-local names.
  let transparency: TransparencyMode = "alpha_test";
  let cull = true;
  let emissive = false;
  let alphaTest = 0.5;

  if (key.includes("alphablend") || key.includes("blend")) {
    transparency = "blend";
    alphaTest = 0;
  } else if (key.includes("alphatest") || key.includes("alpha_test")) {
    transparency = "alpha_test";
    alphaTest = 0.5;
  } else if (
    key === "entity" ||
    key.endsWith("_static") ||
    key.includes("opaque")
  ) {
    transparency = "opaque";
    alphaTest = 0;
  }

  if (key.includes("emissive") || key.includes("glow")) emissive = true;
  if (
    key.includes("nocull") ||
    key.includes("no_cull") ||
    key.includes("invisible") ||
    key.endsWith("_outer")
  ) {
    cull = false;
  }
  if (key.includes("one_sided") || key.includes("onesided")) cull = true;

  return { transparency, cull, emissive, alphaTest };
}

/** RGBA in 0–1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 };

/**
 * Evaluate a Molang-valued RGBA colour block.
 *
 * @param color - Parsed RC colour fields (string Molang or number).
 * @param inputs - Entity inputs for the host.
 * @returns RGBA 0–1.
 */
export function evalColor(
  color: RenderControllerColor | undefined,
  inputs: EntityRenderInputs,
): Rgba {
  if (!color) return { ...WHITE };
  const host = createEntityMolangHost(inputs);
  return {
    r: clamp01(evalChannel(color.r, host, 1)),
    g: clamp01(evalChannel(color.g, host, 1)),
    b: clamp01(evalChannel(color.b, host, 1)),
    a: clamp01(evalChannel(color.a, host, 1)),
  };
}

/**
 * Compose RC colour fields into a single tint.
 *
 * Order (Bedrock-ish): start from `color`, lerp toward `overlay_color` by its
 * alpha (hurt flash), then toward `on_fire_color` / `is_hurt_color` the same way
 * when present.
 *
 * @param colors - Evaluated colour slots.
 * @returns final RGB tint + overall opacity multiplier in `a`.
 */
export function composeControllerTint(colors: {
  color?: Rgba;
  overlay?: Rgba;
  onFire?: Rgba;
  isHurt?: Rgba;
}): Rgba {
  let out = colors.color ? { ...colors.color } : { ...WHITE };
  if (colors.overlay) out = lerpRgba(out, colors.overlay, colors.overlay.a);
  if (colors.isHurt) out = lerpRgba(out, colors.isHurt, colors.isHurt.a);
  if (colors.onFire) out = lerpRgba(out, colors.onFire, colors.onFire.a);
  return out;
}

/**
 * Build a THREE material from texture + material state + optional tint.
 *
 * @param texture - Skin / layer texture.
 * @param state - Mapped material state.
 * @param tint - Optional composed RC tint.
 * @returns MeshBasicMaterial (entities are unlit in this viewer).
 */
export function createEntityMaterial(
  texture: THREE.Texture,
  state: MaterialRenderState = DEFAULT_ENTITY_MATERIAL,
  tint: Rgba = WHITE,
): THREE.MeshBasicMaterial {
  const transparent = state.transparency === "blend";
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    color: new THREE.Color(tint.r, tint.g, tint.b),
    opacity: tint.a,
    transparent: transparent || tint.a < 1,
    alphaTest: state.transparency === "alpha_test" ? state.alphaTest : 0,
    side: state.cull ? THREE.FrontSide : THREE.DoubleSide,
    depthWrite: state.transparency !== "blend",
    // ponytail: MeshBasicMaterial is always unlit; `emissive` only documents
    // intent / future lit materials. Ceiling: no light-reactive entity shaders.
  });
  mat.userData.emissive = state.emissive;
  mat.userData.materialState = state;
  return mat;
}

/**
 * Apply a composed tint onto every MeshBasicMaterial under a root.
 *
 * @param root - Model root.
 * @param tint - Composed RGBA.
 */
export function applyTintToRoot(root: THREE.Object3D, tint: Rgba): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!(m instanceof THREE.MeshBasicMaterial)) continue;
      m.color.setRGB(tint.r, tint.g, tint.b);
      m.opacity = tint.a;
      if (tint.a < 1) m.transparent = true;
    }
  });
}

/**
 * @param a - Base colour.
 * @param b - Overlay colour.
 * @param t - Blend factor (usually overlay alpha).
 * @returns lerped RGB; alpha stays from `a` unless t forces transparency.
 */
export function lerpRgba(a: Rgba, b: Rgba, t: number): Rgba {
  const k = clamp01(t);
  return {
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k,
    a: a.a + (b.a - a.a) * k,
  };
}

/**
 * @param channel - Molang string or literal number.
 * @param host - Entity Molang host.
 * @param fallback - Default when missing.
 * @returns numeric channel.
 */
function evalChannel(
  channel: string | number | undefined,
  host: ReturnType<typeof createEntityMolangHost>,
  fallback: number,
): number {
  if (channel === undefined) return fallback;
  if (typeof channel === "number") return channel;
  const s = channel.trim();
  if (!s) return fallback;
  const asNum = Number(s);
  if (Number.isFinite(asNum) && !/[a-zA-Z_]/.test(s)) return asNum;
  try {
    const v = compile(s).evaluate(host);
    return molangNumber(v, fallback);
  } catch {
    return fallback;
  }
}

/**
 * @param v - Molang value.
 * @param fallback - Default.
 * @returns number.
 */
function molangNumber(v: MolangValue, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/**
 * @param n - Value.
 * @returns clamped 0–1.
 */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
