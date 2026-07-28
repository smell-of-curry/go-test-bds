/** Short-name → geometry / texture / material identifier maps from a client entity. */
export interface ClientEntityMaps {
  materials: Record<string, string>;
  textures: Record<string, string>;
  geometry: Record<string, string>;
}

/** `description.scripts` — initialize / pre_animation / animate. */
export interface ClientEntityScripts {
  /** Run once when the entity instance starts animating. */
  initialize: string[];
  /** Run every frame before animate / controllers. */
  pre_animation: string[];
  /**
   * Root playback list: bare short name, or `{ name: conditionMolang }`.
   * Condition truthy → play; numeric conditions also act as blend weight
   * (e.g. `query.modified_move_speed`).
   */
  animate: Array<{ name: string; condition?: string }>;
  /** Optional Molang / literal scale. */
  scale?: string;
}

/** One `minecraft:client_entity` description, normalised. */
export interface ClientEntityDef {
  identifier: string;
  materials: Record<string, string>;
  textures: Record<string, string>;
  geometry: Record<string, string>;
  /**
   * Short name → full `animation.*` or `controller.animation.*` identifier.
   */
  animations: Record<string, string>;
  scripts: ClientEntityScripts;
  /**
   * Render controller refs: bare name, or `{ name: conditionMolang }`.
   * Conditions are evaluated in order; every true (or bare) entry is active.
   */
  renderControllers: Array<{ name: string; condition?: string }>;
  /** Optional Molang / literal scale from `scripts.scale`. */
  scale?: string;
  /** Pack-relative path the def was loaded from (debug). */
  sourcePath?: string;
}

/** Arrays block inside a render controller. */
export interface RenderControllerArrays {
  materials: Record<string, string[]>;
  geometries: Record<string, string[]>;
  textures: Record<string, string[]>;
}

/** Parsed `controller.render.*` entry (common subset). */
export interface RenderControllerDef {
  name: string;
  geometry?: string;
  textures: string[];
  materials: Array<Record<string, string>>;
  partVisibility: Array<Record<string, string | boolean | number>>;
  arrays: RenderControllerArrays;
}

/** Inputs that affect geometry / texture selection (cache key). */
export interface EntityRenderInputs {
  type: string;
  player: boolean;
  props: Record<string, string | number | boolean>;
  flags: Record<string, boolean>;
  /** Variant / mark_variant convenience (also readable via props when present). */
  variant?: number;
  markVariant?: number;
}

/** Resolved selection after evaluating one render controller. */
export interface ResolvedControllerPass {
  controllerName: string;
  geometryId: string;
  texturePaths: string[];
  /** Bone name → visible. Missing → default visible. */
  partVisibility: Map<string, boolean>;
}
