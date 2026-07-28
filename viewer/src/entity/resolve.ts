import { compile, type MolangValue } from "../molang";
import { createEntityMolangHost } from "./queries";
import type {
  ClientEntityDef,
  EntityRenderInputs,
  RenderControllerDef,
  ResolvedControllerPass,
} from "./types";

/**
 * Pick active render controllers for an entity and resolve geometry / textures /
 * part_visibility for each.
 *
 * @param def - Client entity definition.
 * @param controllers - Loaded controller map.
 * @param inputs - Live entity props/flags.
 * @returns one pass per active controller (may be empty).
 */
export function resolveRenderPasses(
  def: ClientEntityDef,
  controllers: Map<string, RenderControllerDef>,
  inputs: EntityRenderInputs,
): ResolvedControllerPass[] {
  const active = selectControllers(def, inputs);
  const passes: ResolvedControllerPass[] = [];
  for (const name of active) {
    const rc = controllers.get(name);
    if (!rc) continue;
    const pass = resolveOnePass(def, rc, inputs);
    if (pass) passes.push(pass);
  }
  return passes;
}

/**
 * Evaluate controller conditions; bare entries always win.
 * When every conditioned entry fails, fall back to the first bare entry or the
 * first controller listed.
 *
 * @param def - Client entity.
 * @param inputs - Entity inputs for Molang.
 * @returns controller names in declaration order.
 */
export function selectControllers(
  def: ClientEntityDef,
  inputs: EntityRenderInputs,
): string[] {
  if (def.renderControllers.length === 0) {
    return ["controller.render.default"];
  }
  const host = createEntityMolangHost(inputs);
  const chosen: string[] = [];
  const bare: string[] = [];
  for (const ref of def.renderControllers) {
    if (!ref.condition) {
      bare.push(ref.name);
      chosen.push(ref.name);
      continue;
    }
    if (truthy(evalMolang(ref.condition, host))) chosen.push(ref.name);
  }
  if (chosen.length > 0) return chosen;
  if (bare.length > 0) return [bare[0]!];
  return [def.renderControllers[0]!.name];
}

/**
 * @param def - Client entity (short-name maps).
 * @param rc - One controller.
 * @param inputs - Entity inputs.
 * @returns resolved pass, or null when geometry cannot be resolved.
 */
export function resolveOnePass(
  def: ClientEntityDef,
  rc: RenderControllerDef,
  inputs: EntityRenderInputs,
): ResolvedControllerPass | null {
  const arrayTables = buildArrayTables(rc, def);
  const host = createEntityMolangHost(inputs, arrayTables);

  const geoExpr = rc.geometry ?? "Geometry.default";
  const geometryRef = resolveResourceExpr(geoExpr, host, def, "geometry");
  if (!geometryRef) return null;

  const texturePaths: string[] = [];
  const texList = rc.textures.length > 0 ? rc.textures : ["Texture.default"];
  for (const texExpr of texList) {
    const path = resolveResourceExpr(texExpr, host, def, "texture");
    if (path) texturePaths.push(path);
  }
  if (texturePaths.length === 0) return null;

  const partVisibility = new Map<string, boolean>();
  for (const row of rc.partVisibility) {
    for (const [bone, expr] of Object.entries(row)) {
      const vis =
        typeof expr === "boolean"
          ? expr
          : typeof expr === "number"
            ? expr !== 0
            : truthy(evalMolang(String(expr), host));
      if (bone === "*") {
        // Default for all bones — applied as a baseline; named keys override.
        partVisibility.set("*", vis);
      } else {
        partVisibility.set(bone, vis);
      }
    }
  }

  return {
    controllerName: rc.name,
    geometryId: geometryRef,
    texturePaths,
    partVisibility,
  };
}

/**
 * Resolve a Geometry.x / Texture.x / Array.x expression to a concrete geometry
 * id or texture path.
 *
 * @param expr - Controller field expression.
 * @param host - Molang host with arrays bound.
 * @param def - Client entity short-name tables.
 * @param kind - Whether we want a geometry id or texture path.
 * @returns resolved string, or null.
 */
export function resolveResourceExpr(
  expr: string,
  host: ReturnType<typeof createEntityMolangHost>,
  def: ClientEntityDef,
  kind: "geometry" | "texture",
): string | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;

  // Fast path: bare Geometry.foo / Texture.foo (no indexing / operators).
  if (/^(Geometry|Texture|Material)\.[A-Za-z0-9_]+$/i.test(trimmed)) {
    return expandShortRef(trimmed, def, kind);
  }

  const value = evalMolang(trimmed, host);
  if (typeof value === "string") {
    return expandShortRef(value, def, kind);
  }
  // Array access can yield a resource string already expanded by resolveResource.
  if (value == null) return null;
  return expandShortRef(String(value), def, kind);
}

/**
 * Expand `Geometry.default` / `Texture.steve` / bare geometry ids / texture paths.
 *
 * @param ref - Resource reference or already-expanded path/id.
 * @param def - Client entity maps.
 * @param kind - geometry vs texture.
 * @returns concrete id/path.
 */
export function expandShortRef(
  ref: string,
  def: ClientEntityDef,
  kind: "geometry" | "texture",
): string | null {
  const s = ref.trim();
  if (!s) return null;

  const geo = /^Geometry\.(.+)$/i.exec(s);
  if (geo) {
    const short = geo[1]!;
    return def.geometry[short] ?? def.geometry.default ?? null;
  }
  const tex = /^Texture\.(.+)$/i.exec(s);
  if (tex) {
    const short = tex[1]!;
    return def.textures[short] ?? def.textures.default ?? null;
  }
  const mat = /^Material\.(.+)$/i.exec(s);
  if (mat) {
    // Materials are not paths — ignore for texture/geometry resolution.
    return kind === "geometry" ? null : null;
  }

  // Already a geometry.* id or textures/… path.
  if (kind === "geometry") return s;
  return s;
}

/**
 * Bind controller arrays so `Array.skins[i]` yields Texture.x / Geometry.x refs
 * (then expanded by {@link expandShortRef} after evaluation).
 *
 * @param rc - Controller.
 * @param _def - Client entity (reserved for future Material expansion).
 * @returns arrays for the Molang host.
 */
function buildArrayTables(
  rc: RenderControllerDef,
  _def: ClientEntityDef,
): Record<string, MolangValue[]> {
  const out: Record<string, MolangValue[]> = {};
  for (const [name, items] of Object.entries(rc.arrays.textures)) {
    out[name] = items.slice();
  }
  for (const [name, items] of Object.entries(rc.arrays.geometries)) {
    out[name] = items.slice();
  }
  for (const [name, items] of Object.entries(rc.arrays.materials)) {
    out[name] = items.slice();
  }
  return out;
}

/**
 * Cache-key fragment from the inputs that affect resolved geometry/textures.
 *
 * @param inputs - Entity render inputs.
 * @param passes - Resolved passes.
 * @returns stable cache key string.
 */
export function modelCacheKey(
  inputs: EntityRenderInputs,
  passes: ResolvedControllerPass[],
): string {
  const parts = [
    inputs.type,
    inputs.player ? "p" : "e",
    ...passes.map(
      (p) => `${p.controllerName}|${p.geometryId}|${p.texturePaths.join(",")}`,
    ),
  ];
  // Props that commonly index arrays.
  for (const k of Object.keys(inputs.props).sort()) {
    parts.push(`${k}=${String(inputs.props[k])}`);
  }
  return parts.join(";");
}

/**
 * @param source - Molang source.
 * @param host - Host.
 * @returns evaluation result (0 on error).
 */
function evalMolang(
  source: string,
  host: ReturnType<typeof createEntityMolangHost>,
): MolangValue {
  try {
    return compile(source).evaluate(host);
  } catch {
    return 0;
  }
}

/**
 * @param v - Molang value.
 * @returns Bedrock-truthiness.
 */
function truthy(v: MolangValue): boolean {
  if (v == null) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
