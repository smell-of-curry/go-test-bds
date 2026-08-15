import {
  createDefaultHost,
  type DefaultMolangHost,
  type MolangValue,
} from "../molang";
import type { EntityRenderInputs } from "./types";

/**
 * Build a Molang host whose `query.*` surface is fed from entity snapshot data.
 *
 * Supported (common render-controller subset):
 * - `query.property('name')` / `query.property("name")`
 * - `query.variant`, `query.mark_variant`
 * - `query.is_sneaking`, `query.is_sheared`, and other `query.is_*` via flags
 * - booleans from `flags` when the query name matches the flag key
 *
 * Unknown queries return `0` (default host behaviour).
 *
 * @param inputs - Entity type / props / flags.
 * @param arrays - Optional `array.*` tables (render-controller arrays).
 * @returns a default Molang host.
 */
export function createEntityMolangHost(
  inputs: EntityRenderInputs,
  arrays?: Record<string, MolangValue[]>,
): DefaultMolangHost {
  const props = lowerKeys(inputs.props);
  const flags = lowerKeys(inputs.flags);

  const variant =
    inputs.variant ??
    numProp(props, "variant") ??
    numProp(props, "minecraft:variant") ??
    0;
  const markVariant =
    inputs.markVariant ??
    numProp(props, "mark_variant") ??
    numProp(props, "minecraft:mark_variant") ??
    0;

  return createDefaultHost({
    arrays,
    variables: {
      // Viewer always draws third-person body meshes (not FP HUD).
      is_first_person: 0,
      map_face_icon: 0,
      helmet_layer_visible: 1,
      leg_layer_visible: 1,
      boot_layer_visible: 1,
      chest_layer_visible: 1,
    },
    queries: {
      variant,
      mark_variant: markVariant,
      property: (args) => {
        const key = molangStringArg(args[0]);
        if (!key) return 0;
        const v = props[key.toLowerCase()];
        if (v === undefined) return 0;
        if (typeof v === "boolean") return v ? 1 : 0;
        if (typeof v === "number") return v;
        if (typeof v === "string") {
          const n = Number(v);
          return Number.isFinite(n) ? n : v;
        }
        return 0;
      },
      is_sneaking: flagOr(flags, "sneaking", "is_sneaking"),
      is_sheared: flagOr(flags, "sheared", "is_sheared"),
      is_baby: flagOr(flags, "baby", "is_baby"),
      is_on_ground: flagOr(flags, "on_ground", "is_on_ground", true),
      is_in_water: flagOr(flags, "in_water", "is_in_water"),
      is_swimming: flagOr(flags, "swimming", "is_swimming"),
      is_sleeping: flagOr(flags, "sleeping", "is_sleeping"),
      is_alive: 1,
      is_spectator: 0,
      has_cape: 0,
      // Stage 9: overwritten each frame by EntityAnimator.
      anim_time: 0,
      delta_time: 0,
      life_time: 0,
      modified_distance_moved: 0,
      modified_move_speed: 0,
      ground_speed: 0,
      vertical_speed: 0,
      all_animations_finished: 0,
      any_animation_finished: 0,
    },
  });
}

/**
 * @param args0 - First Molang arg.
 * @returns string contents when the value is a string.
 */
function molangStringArg(args0: MolangValue | undefined): string | null {
  return typeof args0 === "string" ? args0 : null;
}

/**
 * @param flags - Lower-cased flags.
 * @param keys - Candidate flag names.
 * @param defaultTrue - When no flag is present, return this (as 0/1).
 * @returns 0 or 1.
 */
function flagOr(
  flags: Record<string, boolean>,
  ...keysAndDefault: Array<string | boolean>
): number {
  let defaultVal = false;
  const keys: string[] = [];
  for (const k of keysAndDefault) {
    if (typeof k === "boolean") defaultVal = k;
    else keys.push(k);
  }
  for (const k of keys) {
    if (k in flags) return flags[k] ? 1 : 0;
  }
  return defaultVal ? 1 : 0;
}

/**
 * @param props - Lower-cased props.
 * @param key - Prop name.
 * @returns finite number or undefined.
 */
function numProp(
  props: Record<string, string | number | boolean>,
  key: string,
): number | undefined {
  const v = props[key.toLowerCase()];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * @param obj - Record with mixed-case keys.
 * @returns new record with lower-cased keys.
 */
function lowerKeys<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) out[k.toLowerCase()] = v;
  return out;
}
