/**
 * JSON UI resolver: merge pack layers, walk inheritance, substitute $variables,
 * and expand controls into {@link ResolvedElement} trees.
 */

import type {
  ElementName,
  PropertyBag,
  ResolvedChild,
  ResolvedElement,
  UiFileSource,
  UiResolver,
} from "./types";

/** Merged element definition before inheritance resolve. */
interface StoredDef {
  namespace: string;
  name: string;
  /** Inheritance target from the definition key (`name@ns.base`). */
  base?: { namespace?: string; name: string };
  props: PropertyBag;
}

interface Modification {
  array_name?: string;
  control_name?: string;
  operation?: string;
  value?: unknown;
  where?: Record<string, unknown>;
  target?: Record<string, unknown>;
}

/**
 * Parse an element / control key into name + optional base/ref.
 *
 * @param key - e.g. `"root_panel@common.base"`, `"foo@bar"`, `"foo"`.
 * @returns parsed name parts.
 */
export function parseElementName(key: string): ElementName {
  const at = key.indexOf("@");
  if (at < 0) return { name: key };
  const name = key.slice(0, at);
  const ref = key.slice(at + 1);
  if (!ref) return { name };
  const dot = ref.indexOf(".");
  if (dot >= 0) {
    return {
      name,
      base: { namespace: ref.slice(0, dot), name: ref.slice(dot + 1) },
    };
  }
  return { name, base: { name: ref } };
}

/**
 * Build a memoizing {@link UiResolver} from pack-ordered ui file sources.
 *
 * Variable precedence (highest → lowest): instance override → derived element →
 * base chain → pack globals from `_global_variables.json`.
 *
 * @param files - Layers from {@link loadUiFileSet} (lowest pack first).
 * @param globals - Optional merged `$variables` from `_global_variables.json`.
 * @returns resolver.
 */
export function buildResolver(
  files: UiFileSource[],
  globals: PropertyBag = {},
): UiResolver {
  const globalVars: PropertyBag = {};
  for (const [k, v] of Object.entries(globals)) {
    if (k.startsWith("$")) globalVars[k] = v;
  }

  /** namespace → element name → merged def */
  const defs = new Map<string, Map<string, StoredDef>>();

  for (const file of files) {
    const ns = file.raw.namespace;
    let nsMap = defs.get(ns);
    if (!nsMap) {
      nsMap = new Map();
      defs.set(ns, nsMap);
    }
    for (const [key, props] of Object.entries(file.raw.elements)) {
      const parsed = parseElementName(key);
      const existing = nsMap.get(parsed.name);
      if (!existing) {
        nsMap.set(parsed.name, {
          namespace: ns,
          name: parsed.name,
          base: parsed.base,
          props: cloneJson(props),
        });
        continue;
      }
      mergePackLayer(existing, parsed.base, props);
    }
  }

  const memo = new Map<string, ResolvedElement>();

  function resolve(
    namespace: string,
    name: string,
    varOverrides?: PropertyBag,
    stack?: Set<string>,
  ): ResolvedElement | undefined {
    const hasOverrides = varOverrides && Object.keys(varOverrides).length > 0;
    const memoKey = `${namespace}\0${name}`;
    if (!hasOverrides) {
      const hit = memo.get(memoKey);
      if (hit) return hit;
    }

    const nsMap = defs.get(namespace);
    const def = nsMap?.get(name);
    if (!def) return undefined;

    const chainKey = memoKey;
    const resolving = stack ?? new Set<string>();
    if (resolving.has(chainKey)) {
      return {
        type: "panel",
        name,
        namespace,
        props: {},
        controls: [],
        bindings: [],
      };
    }
    resolving.add(chainKey);

    const chain = collectBaseChain(def, defs);
    const merged: PropertyBag = {};
    for (const d of chain) {
      shallowAssign(merged, d.props);
    }

    const vars = collectVariables(chain, varOverrides, globalVars);
    const substituted = substituteVars(merged, vars) as PropertyBag;

    const type =
      typeof substituted.type === "string"
        ? substituted.type
        : typeof substituted.anim_type === "string"
          ? "animation"
          : "panel";

    const bindingsRaw = substituted.bindings;
    const bindings: PropertyBag[] = Array.isArray(bindingsRaw)
      ? (bindingsRaw.filter(
          (b) => b && typeof b === "object" && !Array.isArray(b),
        ) as PropertyBag[])
      : [];

    const controlsRaw = substituted.controls;
    const controls: ResolvedChild[] = [];
    if (Array.isArray(controlsRaw)) {
      for (const entry of controlsRaw) {
        const child = resolveControlEntry(entry, namespace, vars, resolving);
        if (child) controls.push(child);
      }
    }

    // Keep `$…` keys on props — binding-time expressions (sidebar `$string_parser`,
    // PHUD `$update_string`) read them via ExprScope.variable().
    const props = elementProps(substituted, vars);
    delete props.controls;
    delete props.bindings;
    delete props.modifications;

    const resolved: ResolvedElement = {
      type,
      name,
      namespace,
      props,
      controls,
      bindings,
    };

    resolving.delete(chainKey);
    if (!hasOverrides) memo.set(memoKey, resolved);
    return resolved;
  }

  function resolveControlEntry(
    entry: unknown,
    parentNs: string,
    parentVars: PropertyBag,
    stack: Set<string>,
  ): ResolvedChild | undefined {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return undefined;
    }
    const keys = Object.keys(entry as object);
    if (keys.length === 0) return undefined;
    const rawKey = keys[0]!;
    const instanceProps = (entry as Record<string, unknown>)[rawKey];
    const inst =
      instanceProps &&
      typeof instanceProps === "object" &&
      !Array.isArray(instanceProps)
        ? (instanceProps as PropertyBag)
        : {};

    const key = substituteKeyVars(rawKey, parentVars);
    const parsed = parseElementName(key);

    // Inline anonymous: no @ref
    if (!parsed.base) {
      const inlineVars = collectVariablesFromProps(inst, parentVars);
      const sub = substituteVars({ ...inst }, inlineVars) as PropertyBag;
      const type =
        typeof sub.type === "string"
          ? sub.type
          : typeof sub.anim_type === "string"
            ? "animation"
            : "panel";
      const bindingsRaw = sub.bindings;
      const bindings: PropertyBag[] = Array.isArray(bindingsRaw)
        ? (bindingsRaw.filter(
            (b) => b && typeof b === "object" && !Array.isArray(b),
          ) as PropertyBag[])
        : [];
      const controls: ResolvedChild[] = [];
      if (Array.isArray(sub.controls)) {
        for (const c of sub.controls) {
          const ch = resolveControlEntry(c, parentNs, inlineVars, stack);
          if (ch) controls.push(ch);
        }
      }
      const props = elementProps(sub, inlineVars);
      delete props.controls;
      delete props.bindings;
      return {
        id: parsed.name,
        element: {
          type,
          name: parsed.name,
          namespace: parentNs,
          props,
          controls,
          bindings,
        },
      };
    }

    const refNs = parsed.base.namespace ?? parentNs;
    const refName = parsed.base.name;

    // Instance $vars may reference parent vars — resolve those first.
    const overrideVars: PropertyBag = {};
    for (const [k, v] of Object.entries(inst)) {
      if (!k.startsWith("$")) continue;
      const { varName } = parseVarKey(k);
      overrideVars[`$${varName}`] = substituteVars(v, parentVars);
    }
    // Parent scope $vars must flow into the child (sidebar `$var_size`, etc.).
    const childVars = { ...parentVars, ...overrideVars };
    // Non-$ instance props also override after child resolve — pass as var-less
    // property overrides by re-merging onto the resolved child.
    const child = resolve(refNs, refName, childVars, stack);
    if (!child) {
      const stubProps = elementProps(
        substituteVars({ ...inst }, parentVars) as PropertyBag,
        childVars,
      );
      delete stubProps.controls;
      delete stubProps.bindings;
      return {
        id: parsed.name,
        element: {
          type: typeof stubProps.type === "string" ? stubProps.type : "panel",
          name: refName,
          namespace: refNs,
          props: stubProps,
          controls: [],
          bindings: [],
        },
      };
    }

    // Apply non-variable instance property overrides (derived-most).
    const nonVarOverrides: PropertyBag = {};
    for (const [k, v] of Object.entries(inst)) {
      if (k.startsWith("$")) continue;
      nonVarOverrides[k] = substituteVars(v, childVars);
    }
    if (Object.keys(nonVarOverrides).length === 0) {
      // Still ensure parent/instance $vars are on the child props for bindings.
      const withVars = { ...child.props };
      for (const [k, v] of Object.entries(childVars)) {
        if (k.startsWith("$")) withVars[k] = v;
      }
      return {
        id: parsed.name,
        element: { ...child, props: withVars },
      };
    }
    const props = {
      ...child.props,
      ...elementProps(nonVarOverrides as PropertyBag, childVars),
    };
    delete props.controls;
    delete props.bindings;
    const type =
      typeof nonVarOverrides.type === "string"
        ? nonVarOverrides.type
        : child.type;
    let controls = child.controls;
    if (Array.isArray(nonVarOverrides.controls)) {
      controls = [];
      for (const c of nonVarOverrides.controls) {
        const ch = resolveControlEntry(c, refNs, childVars, stack);
        if (ch) controls.push(ch);
      }
    }
    let bindings = child.bindings;
    if (Array.isArray(nonVarOverrides.bindings)) {
      bindings = nonVarOverrides.bindings.filter(
        (b) => b && typeof b === "object" && !Array.isArray(b),
      ) as PropertyBag[];
    }
    return {
      id: parsed.name,
      element: {
        type,
        name: child.name,
        namespace: child.namespace,
        props,
        controls,
        bindings,
      },
    };
  }

  return {
    resolve(namespace: string, name: string): ResolvedElement | undefined {
      return resolve(namespace, name);
    },
    screens(): string[] {
      const out: string[] = [];
      for (const [ns, nsMap] of defs) {
        for (const [name, def] of nsMap) {
          if (peekType(def, defs) === "screen") out.push(`${ns}.${name}`);
        }
      }
      return out;
    },
  };
}

/**
 * Resolve only the control `type` along the base chain (no control expansion).
 *
 * @param def - Element definition.
 * @param defs - Global def map.
 * @returns type string.
 */
function peekType(
  def: StoredDef,
  defs: Map<string, Map<string, StoredDef>>,
): string {
  const chain = collectBaseChain(def, defs);
  let type: string | undefined;
  for (const d of chain) {
    if (typeof d.props.type === "string") type = d.props.type;
  }
  return type ?? "panel";
}

/**
 * Merge a later pack's element definition onto an earlier one.
 *
 * @param existing - Accumulator def.
 * @param newBase - Base from the later key, if any.
 * @param props - Later pack's property bag.
 */
function mergePackLayer(
  existing: StoredDef,
  newBase: ElementName["base"],
  props: PropertyBag,
): void {
  const mods = props.modifications;
  if (Array.isArray(mods)) {
    for (const mod of mods) {
      if (mod && typeof mod === "object")
        applyModification(existing.props, mod as Modification);
    }
  }
  if (newBase) existing.base = newBase;
  for (const [k, v] of Object.entries(props)) {
    if (k === "modifications") continue;
    existing.props[k] = cloneJson(v);
  }
}

/**
 * Apply one modifications[] entry to a property bag.
 *
 * @param props - Element props to mutate.
 * @param mod - Modification descriptor.
 */
function applyModification(props: PropertyBag, mod: Modification): void {
  const op = mod.operation;
  if (!op) return;

  if (mod.control_name) {
    const arr = ensureArray(props, "controls");
    const idx = findControlIndex(arr, mod.control_name);
    switch (op) {
      case "insert_after":
        if (idx >= 0) arr.splice(idx + 1, 0, ...asArray(mod.value));
        break;
      case "insert_before":
        if (idx >= 0) arr.splice(idx, 0, ...asArray(mod.value));
        break;
      case "replace":
        if (idx >= 0) {
          const vals = asArray(mod.value);
          arr.splice(idx, 1, ...vals);
        }
        break;
      case "remove":
        if (idx >= 0) arr.splice(idx, 1);
        break;
      case "move_after":
      case "move_before":
      case "move_front":
      case "move_back":
        applyMoveControl(arr, mod, idx);
        break;
      default:
        break;
    }
    return;
  }

  const arrayName = mod.array_name;
  if (!arrayName) return;
  const arr = ensureArray(props, arrayName);

  switch (op) {
    case "insert_back":
      arr.push(...asArray(mod.value));
      break;
    case "insert_front":
      arr.unshift(...asArray(mod.value));
      break;
    case "insert_after": {
      const idx = findWhereIndex(arr, mod.where);
      if (idx >= 0) arr.splice(idx + 1, 0, ...asArray(mod.value));
      break;
    }
    case "insert_before": {
      const idx = findWhereIndex(arr, mod.where);
      if (idx >= 0) arr.splice(idx, 0, ...asArray(mod.value));
      break;
    }
    case "replace": {
      const idx = findWhereIndex(arr, mod.where);
      if (idx >= 0) {
        if (Array.isArray(mod.value)) arr.splice(idx, 1, ...mod.value);
        else arr.splice(idx, 1, mod.value);
      }
      break;
    }
    case "remove": {
      const idx = findWhereIndex(arr, mod.where);
      if (idx >= 0) arr.splice(idx, 1);
      break;
    }
    case "move_front":
    case "move_back":
    case "move_after":
    case "move_before":
      applyMoveWhere(arr, mod);
      break;
    case "swap": {
      const a = findWhereIndex(arr, mod.where);
      const b = findWhereIndex(arr, mod.target);
      if (a >= 0 && b >= 0) {
        const tmp = arr[a];
        arr[a] = arr[b];
        arr[b] = tmp;
      }
      break;
    }
    default:
      break;
  }
}

/**
 * @param arr - Controls array.
 * @param mod - Move modification.
 * @param idx - Index of control_name target.
 */
function applyMoveControl(
  arr: unknown[],
  mod: Modification,
  idx: number,
): void {
  if (idx < 0) return;
  const [item] = arr.splice(idx, 1);
  switch (mod.operation) {
    case "move_front":
      arr.unshift(item);
      break;
    case "move_back":
      arr.push(item);
      break;
    case "move_after": {
      // value[0] names the anchor control
      const anchor = firstControlId(asArray(mod.value)[0]);
      const aidx = anchor ? findControlIndex(arr, anchor) : -1;
      if (aidx >= 0) arr.splice(aidx + 1, 0, item);
      else arr.push(item);
      break;
    }
    case "move_before": {
      const anchor = firstControlId(asArray(mod.value)[0]);
      const aidx = anchor ? findControlIndex(arr, anchor) : -1;
      if (aidx >= 0) arr.splice(aidx, 0, item);
      else arr.unshift(item);
      break;
    }
    default:
      break;
  }
}

/**
 * @param arr - Target array.
 * @param mod - Move modification using where/target.
 */
function applyMoveWhere(arr: unknown[], mod: Modification): void {
  const idx = findWhereIndex(arr, mod.where);
  if (idx < 0) return;
  const [item] = arr.splice(idx, 1);
  switch (mod.operation) {
    case "move_front":
      arr.unshift(item);
      break;
    case "move_back":
      arr.push(item);
      break;
    case "move_after": {
      const t = findWhereIndex(arr, mod.target ?? mod.where);
      if (t >= 0) arr.splice(t + 1, 0, item);
      else arr.push(item);
      break;
    }
    case "move_before": {
      const t = findWhereIndex(arr, mod.target ?? mod.where);
      if (t >= 0) arr.splice(t, 0, item);
      else arr.unshift(item);
      break;
    }
    default:
      break;
  }
}

/**
 * Walk base chain root→derived (cycle-safe).
 *
 * @param def - Starting definition.
 * @param defs - Global def map.
 * @returns chain from furthest base to def.
 */
function collectBaseChain(
  def: StoredDef,
  defs: Map<string, Map<string, StoredDef>>,
): StoredDef[] {
  const chain: StoredDef[] = [];
  const seen = new Set<string>();
  let cur: StoredDef | undefined = def;
  while (cur) {
    const key = `${cur.namespace}\0${cur.name}`;
    if (seen.has(key)) break;
    seen.add(key);
    chain.push(cur);
    const base = cur.base;
    if (!base) break;
    const baseNs: string = base.namespace ?? cur.namespace;
    const baseName: string = base.name;
    const nextDef: StoredDef | undefined = defs.get(baseNs)?.get(baseName);
    if (!nextDef) break;
    cur = nextDef;
  }
  chain.reverse();
  return chain;
}

/**
 * Collect $variables: globals (lowest) → base→derived chain → instance overrides.
 *
 * @param chain - Base first, derived last.
 * @param overrides - Instance / caller overrides (`$name` keys).
 * @param globals - Pack-wide globals (lowest precedence).
 * @returns variable map keyed `"$name"`.
 */
function collectVariables(
  chain: StoredDef[],
  overrides: PropertyBag | undefined,
  globals: PropertyBag,
): PropertyBag {
  const vars: PropertyBag = { ...globals };
  for (const d of chain) {
    applyVarDeclarations(vars, d.props);
  }
  if (overrides) applyVarDeclarations(vars, overrides, true);
  return vars;
}

/**
 * @param base - Parent vars.
 * @param props - Props that may declare/override vars.
 * @returns vars for this instance scope.
 */
function collectVariablesFromProps(
  props: PropertyBag,
  base: PropertyBag,
): PropertyBag {
  const vars = { ...base };
  applyVarDeclarations(vars, props, true);
  return vars;
}

/**
 * Read `$name` / `$name|default` keys into the var map.
 *
 * @param vars - Destination map.
 * @param props - Source props.
 * @param force - When true, always overwrite (instance overrides).
 */
function applyVarDeclarations(
  vars: PropertyBag,
  props: PropertyBag,
  force = false,
): void {
  for (const [k, v] of Object.entries(props)) {
    if (!k.startsWith("$")) continue;
    const { varName, isDefault } = parseVarKey(k);
    const key = `$${varName}`;
    if (isDefault && !force && key in vars) continue;
    vars[key] = v;
  }
}

/**
 * @param key - Property key starting with `$`.
 * @returns var name and whether this is a `|default` declaration.
 */
function parseVarKey(key: string): { varName: string; isDefault: boolean } {
  const body = key.slice(1);
  const pipe = body.indexOf("|");
  if (pipe >= 0 && body.slice(pipe + 1) === "default") {
    return { varName: body.slice(0, pipe), isDefault: true };
  }
  if (pipe >= 0) {
    // `$name|default` is the canonical form; other suffixes treated as name|…
    return { varName: body.slice(0, pipe), isDefault: true };
  }
  return { varName: body, isDefault: false };
}

/**
 * Substitute `$var` / `$var|fallback` property values recursively.
 *
 * @param value - Any JSON value.
 * @param vars - Variable map.
 * @returns value with substitutions applied.
 */
function substituteVars(value: unknown, vars: PropertyBag): unknown {
  if (typeof value === "string") {
    return substituteString(value, vars);
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteVars(v, vars));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Keep declaration keys; substitute their values.
      out[k] = substituteVars(v, vars);
    }
    return out;
  }
  return value;
}

/**
 * @param value - String property value.
 * @param vars - Variable map.
 * @returns substituted value (may change type) or original string.
 */
function substituteString(value: string, vars: PropertyBag): unknown {
  if (!value.startsWith("$")) return value;
  // `$name` exact
  if (value in vars) return vars[value];
  // `$name|fallback`
  const pipe = value.indexOf("|");
  if (pipe > 1) {
    const name = value.slice(0, pipe);
    const fallback = value.slice(pipe + 1);
    if (name in vars) return vars[name];
    return fallback;
  }
  return value;
}

/**
 * Substitute `$var` tokens inside a control key (e.g. `panel@$screen_content`).
 *
 * @param key - Raw control key.
 * @param vars - Variable map.
 * @returns key with vars expanded.
 */
function substituteKeyVars(key: string, vars: PropertyBag): string {
  return key.replace(/\$[A-Za-z0-9_]+/g, (match) => {
    if (!(match in vars)) return match;
    const v = vars[match];
    return typeof v === "string" ? v : match;
  });
}

/**
 * Build the resolved property bag for an element, keeping `$…` variables so
 * the binding engine can evaluate expressions that reference them.
 *
 * @param substituted - Props after `$var` substitution of values.
 * @param vars - Full variable scope (globals + chain + parent + instance).
 * @returns props copy without structural keys; `$…` keys retained.
 */
function elementProps(
  substituted: PropertyBag,
  vars: PropertyBag,
): PropertyBag {
  const out: PropertyBag = {};
  for (const [k, v] of Object.entries(substituted)) {
    if (k === "controls" || k === "bindings" || k === "modifications") continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(vars)) {
    if (!k.startsWith("$")) continue;
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/**
 * @param props - Element props.
 * @param name - Array property name.
 * @returns mutable array (created if missing).
 */
function ensureArray(props: PropertyBag, name: string): unknown[] {
  const cur = props[name];
  if (Array.isArray(cur)) return cur;
  const arr: unknown[] = [];
  props[name] = arr;
  return arr;
}

/**
 * @param value - Modification value.
 * @returns array form.
 */
function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * @param arr - controls array.
 * @param controlName - Instance id to find.
 * @returns index or -1.
 */
function findControlIndex(arr: unknown[], controlName: string): number {
  for (let i = 0; i < arr.length; i++) {
    const id = firstControlId(arr[i]);
    if (id === controlName) return i;
  }
  return -1;
}

/**
 * @param entry - Single controls[] object.
 * @returns instance id (left of @) or undefined.
 */
function firstControlId(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    return undefined;
  const key = Object.keys(entry as object)[0];
  if (!key) return undefined;
  return parseElementName(key).name;
}

/**
 * @param arr - Array of objects.
 * @param where - Partial object match, or undefined.
 * @returns index or -1.
 */
function findWhereIndex(
  arr: unknown[],
  where: Record<string, unknown> | undefined,
): number {
  if (!where) return -1;
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (objectMatches(item as Record<string, unknown>, where)) return i;
  }
  return -1;
}

/**
 * @param obj - Candidate.
 * @param where - Required key/value pairs.
 * @returns true when all where entries match.
 */
function objectMatches(
  obj: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (obj[k] !== v) return false;
  }
  return true;
}

/**
 * @param target - Destination object.
 * @param src - Source props (shallow).
 */
function shallowAssign(target: PropertyBag, src: PropertyBag): void {
  for (const [k, v] of Object.entries(src)) {
    if (k === "modifications") continue;
    target[k] = cloneJson(v);
  }
}

/**
 * @param value - JSON-compatible value.
 * @returns deep clone via JSON (ui trees are JSON).
 */
function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
