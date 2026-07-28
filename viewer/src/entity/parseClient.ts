import type { ClientEntityDef, ClientEntityScripts } from "./types";

/**
 * Parse a Bedrock client entity JSON document
 * (`minecraft:client_entity.description`).
 *
 * @param input - Parsed JSON value.
 * @param sourcePath - Optional pack path for diagnostics.
 * @returns Normalised client entity def, or null when the document is not one.
 */
export function parseClientEntity(
  input: unknown,
  sourcePath?: string,
): ClientEntityDef | null {
  if (!isObject(input)) return null;
  const root = input["minecraft:client_entity"];
  if (!isObject(root)) return null;
  const desc = root.description;
  if (!isObject(desc)) return null;

  const identifier = asString(desc.identifier);
  if (!identifier) return null;

  const renderControllers = parseRenderControllerList(desc.render_controllers);
  const scripts = parseScripts(desc.scripts);

  return {
    identifier,
    materials: stringMap(desc.materials),
    textures: stringMap(desc.textures),
    geometry: stringMap(desc.geometry),
    animations: stringMap(desc.animations),
    scripts,
    renderControllers,
    scale: scripts.scale,
    sourcePath,
  };
}

/**
 * @param list - `description.render_controllers` value.
 * @returns normalised controller refs.
 */
function parseRenderControllerList(
  list: unknown,
): Array<{ name: string; condition?: string }> {
  if (!Array.isArray(list)) return [];
  const out: Array<{ name: string; condition?: string }> = [];
  for (const entry of list) {
    if (typeof entry === "string" && entry) {
      out.push({ name: entry });
      continue;
    }
    if (!isObject(entry)) continue;
    for (const [name, cond] of Object.entries(entry)) {
      if (!name) continue;
      out.push({
        name,
        condition: typeof cond === "string" ? cond : String(cond),
      });
    }
  }
  return out;
}

/**
 * Parse `description.scripts` (initialize / pre_animation / animate / scale).
 *
 * Variable assignment order (MS Learn / bedrock.dev): initialize once, then
 * each frame pre_animation in list order, then animate conditions.
 *
 * @param scripts - Raw scripts object.
 * @returns normalised scripts.
 */
function parseScripts(scripts: unknown): ClientEntityScripts {
  if (!isObject(scripts)) {
    return { initialize: [], pre_animation: [], animate: [] };
  }
  const scale =
    typeof scripts.scale === "number" && Number.isFinite(scripts.scale)
      ? String(scripts.scale)
      : typeof scripts.scale === "string" && scripts.scale
        ? scripts.scale
        : undefined;
  return {
    initialize: molangList(scripts.initialize),
    pre_animation: molangList(scripts.pre_animation),
    animate: parseAnimateList(scripts.animate),
    scale,
  };
}

/**
 * @param list - Array or single string/object of Molang statements.
 * @returns statement strings.
 */
function molangList(list: unknown): string[] {
  if (typeof list === "string" && list) return [list];
  if (!Array.isArray(list)) {
    // Some docs show an object map; accept values as statements.
    if (isObject(list)) {
      return Object.values(list).filter(
        (v): v is string => typeof v === "string" && !!v,
      );
    }
    return [];
  }
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string" && entry) out.push(entry);
  }
  return out;
}

/**
 * @param list - `scripts.animate` array.
 * @returns animate refs.
 */
function parseAnimateList(
  list: unknown,
): Array<{ name: string; condition?: string }> {
  if (!Array.isArray(list)) return [];
  const out: Array<{ name: string; condition?: string }> = [];
  for (const entry of list) {
    if (typeof entry === "string" && entry) {
      out.push({ name: entry });
      continue;
    }
    if (!isObject(entry)) continue;
    for (const [name, cond] of Object.entries(entry)) {
      if (!name) continue;
      out.push({
        name,
        condition: typeof cond === "string" ? cond : String(cond),
      });
    }
  }
  return out;
}

/**
 * @param v - Unknown map-like value.
 * @returns string→string map (non-strings dropped).
 */
function stringMap(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

/**
 * @param v - Unknown.
 * @returns string or null.
 */
function asString(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/**
 * @param v - Unknown.
 * @returns true when a plain object.
 */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
