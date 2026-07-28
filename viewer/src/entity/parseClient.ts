import type { ClientEntityDef } from "./types";

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

  return {
    identifier,
    materials: stringMap(desc.materials),
    textures: stringMap(desc.textures),
    geometry: stringMap(desc.geometry),
    renderControllers,
    scale: extractScale(desc.scripts),
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
 * @param scripts - `description.scripts` object.
 * @returns scale expression when present.
 */
function extractScale(scripts: unknown): string | undefined {
  if (!isObject(scripts)) return undefined;
  const scale = scripts.scale;
  if (typeof scale === "number" && Number.isFinite(scale)) return String(scale);
  if (typeof scale === "string" && scale) return scale;
  return undefined;
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
