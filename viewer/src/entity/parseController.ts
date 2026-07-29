import type {
  RenderControllerArrays,
  RenderControllerColor,
  RenderControllerDef,
} from "./types";

/**
 * Parse a render_controllers JSON document into named controller defs.
 *
 * @param input - Parsed JSON value.
 * @returns Map of controller name → def (empty when not a controller file).
 */
export function parseRenderControllers(
  input: unknown,
): Map<string, RenderControllerDef> {
  const out = new Map<string, RenderControllerDef>();
  if (!isObject(input)) return out;
  const root = input.render_controllers;
  if (!isObject(root)) return out;

  for (const [name, raw] of Object.entries(root)) {
    if (!isObject(raw)) continue;
    out.set(name, parseOne(name, raw));
  }
  return out;
}

/**
 * @param name - Controller identifier.
 * @param raw - Controller object.
 * @returns normalised def.
 */
function parseOne(
  name: string,
  raw: Record<string, unknown>,
): RenderControllerDef {
  const texturesRaw = raw.textures;
  const textures: string[] = [];
  if (typeof texturesRaw === "string") textures.push(texturesRaw);
  else if (Array.isArray(texturesRaw)) {
    for (const t of texturesRaw) {
      if (typeof t === "string") textures.push(t);
    }
  }

  const materials: Array<Record<string, string>> = [];
  if (Array.isArray(raw.materials)) {
    for (const entry of raw.materials) {
      if (!isObject(entry)) continue;
      const row: Record<string, string> = {};
      for (const [k, v] of Object.entries(entry)) {
        if (typeof v === "string") row[k] = v;
      }
      materials.push(row);
    }
  }

  const partVisibility: Array<Record<string, string | boolean | number>> = [];
  if (Array.isArray(raw.part_visibility)) {
    for (const entry of raw.part_visibility) {
      if (!isObject(entry)) continue;
      const row: Record<string, string | boolean | number> = {};
      for (const [k, v] of Object.entries(entry)) {
        if (
          typeof v === "string" ||
          typeof v === "boolean" ||
          typeof v === "number"
        ) {
          row[k] = v;
        }
      }
      partVisibility.push(row);
    }
  }

  return {
    name,
    geometry: typeof raw.geometry === "string" ? raw.geometry : undefined,
    textures,
    materials,
    partVisibility,
    arrays: parseArrays(raw.arrays),
    color: parseColor(raw.color),
    overlayColor: parseColor(raw.overlay_color),
    onFireColor: parseColor(raw.on_fire_color),
    isHurtColor: parseColor(raw.is_hurt_color),
  };
}

/**
 * @param raw - RC colour object (`r`/`g`/`b`/`a` Molang or number).
 * @returns normalised colour or undefined.
 */
function parseColor(raw: unknown): RenderControllerColor | undefined {
  if (!isObject(raw)) return undefined;
  const out: RenderControllerColor = {};
  for (const k of ["r", "g", "b", "a"] as const) {
    const v = raw[k];
    if (typeof v === "string" || typeof v === "number") out[k] = v;
  }
  return out.r !== undefined ||
    out.g !== undefined ||
    out.b !== undefined ||
    out.a !== undefined
    ? out
    : undefined;
}

/**
 * @param raw - `arrays` object.
 * @returns normalised array tables.
 */
function parseArrays(raw: unknown): RenderControllerArrays {
  const empty: RenderControllerArrays = {
    materials: {},
    geometries: {},
    textures: {},
  };
  if (!isObject(raw)) return empty;

  return {
    materials: stringArrayMap(raw.materials),
    geometries: stringArrayMap(raw.geometries),
    textures: stringArrayMap(raw.textures),
  };
}

/**
 * @param raw - Kind bucket (`textures` / `geometries` / `materials`).
 * @returns name → string[] (strips `Array.` prefix from keys).
 */
function stringArrayMap(raw: unknown): Record<string, string[]> {
  if (!isObject(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!Array.isArray(val)) continue;
    const name = key.replace(/^Array\./i, "");
    const items: string[] = [];
    for (const v of val) {
      if (typeof v === "string") items.push(v);
    }
    out[name] = items;
  }
  return out;
}

/**
 * @param v - Unknown.
 * @returns true when a plain object.
 */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
