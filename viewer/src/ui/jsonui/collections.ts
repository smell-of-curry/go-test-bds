/**
 * Collection factory expansion + collection-scoped binding application.
 *
 * Vanilla `server_form.long_form_dynamic_buttons_panel` and PokeBedrock
 * `battle.button_stack` both use `collection_name` + `factory` to instantiate
 * one control per form button. Per-item bindings (`#form_button_text`,
 * `#form_button_texture`, `#collection_index`) resolve against that item.
 */

import {
  applyBindings,
  stripHash,
  type ApplyBindingsOptions,
} from "./bindings.js";
import type {
  BindingSource,
  BindingValue,
  PropertyBag,
  ResolvedChild,
  ResolvedElement,
  UiResolver,
} from "./types.js";

/** One row in a named collection (keys are binding names, usually `#…`). */
export type CollectionItem = Record<string, BindingValue>;

/** Named collections available while expanding / binding a tree. */
export type CollectionMap = Record<string, CollectionItem[]>;

/** Active collection scope for nested binding application. */
export interface CollectionScope {
  name: string;
  index: number;
}

/**
 * Align live BEH button encodings with pack binding expressions in
 * `attack.json` (strip lengths assume fixed field starts).
 *
 * @param text - Raw / Go-flattened button label.
 * @returns text with battle field padding corrected when needed.
 */
export function normalizeFormButtonText(text: string): string {
  return normalizeBattleActorButton(normalizeBattleMoveButton(text));
}

/**
 * Pack move-name binding strips `%.36s` before reading `.moveId`, but BEH
 * joins `b:N_` + pad30(type) + one sep (=35 chars) then `.id`. Insert one
 * sep so index 36 lands on the leading `.` → `showdown.moves.growl.name`.
 *
 * @param text - Button label.
 * @returns padded move encoding, or unchanged.
 */
function normalizeBattleMoveButton(text: string): string {
  // b:1_ + 30 type + sep + .moveid…
  const m = /^(b:\d_)(.{30})([\u00a0 ])(\.)/.exec(text);
  if (!m) return text;
  // Already aligned: char at 35 is sep and char at 36 is '.'.
  if (text[35] === m[3] && text[36] === ".") return text;
  // Live wire: sep at 34, '.' at 35 — insert an extra sep.
  if (text[34] === m[3] && text[35] === ".") {
    return text.slice(0, 35) + m[3] + text.slice(35);
  }
  return text;
}

/**
 * Pack actor plates use details `%.58s`, color at 58, clip at 60, HP after 62.
 * Legacy BEH `padEnd(50, '_')` leaves health 8 chars early → glued
 * "Lv.5G0.0  10". Match on level-line + health float (not only `startsWith(
 * "§0§")`) so mojibake / odd prefixes still realign.
 *
 * @param text - Button label.
 * @returns actor button with details padded to 58, or unchanged.
 */
function normalizeBattleActorButton(text: string): string {
  // Live HP: `G0.0⠀100%%`. Fainted: `G0%⠀Fainted` (no float).
  const m = /([GYR]\d+\.\d+|[GYR]0%)/.exec(text);
  if (!m || m.index == null) return text;
  if (!/\n Lv\.\d/.test(text) && !/§0§[0a]/.test(text)) return text;
  const healthAt = m.index;
  if (healthAt === 58) return text;
  const health = text.slice(healthAt);
  const details = text.slice(0, healthAt).replace(/_+$/, "");
  return details.padEnd(58, "_") + health;
}

/**
 * Build form_buttons collection items from ActionForm button labels + images.
 *
 * @param buttons - Button label strings.
 * @param images - Parallel image paths (optional; `""` when absent).
 * @returns items for `form_buttons`.
 */
export function formButtonsCollection(
  buttons: string[],
  images?: string[],
): CollectionItem[] {
  return buttons.map((text, i) => {
    const texture = images?.[i] ?? "";
    return {
      "#form_button_text": normalizeFormButtonText(text),
      "#form_button_texture": texture,
      // Bedrock uses FileSystem for http/custom pack paths; empty = packed.
      "#form_button_texture_file_system": texture ? "FileSystem" : "",
      "#collection_index": i,
    };
  });
}

/**
 * Deep-clone a resolved element tree (JSON round-trip; ui trees are JSON).
 *
 * @param el - Source element.
 * @returns independent copy.
 */
export function cloneResolved(el: ResolvedElement): ResolvedElement {
  return JSON.parse(JSON.stringify(el)) as ResolvedElement;
}

/**
 * Look up a value on a collection item (accepts `#name` or bare `name`).
 *
 * @param item - Collection row.
 * @param bindingName - Binding name with or without `#`.
 * @returns value, or undefined.
 */
export function readCollectionItem(
  item: CollectionItem,
  bindingName: string,
): BindingValue | undefined {
  if (bindingName in item) return item[bindingName];
  const hashed = bindingName.startsWith("#") ? bindingName : `#${bindingName}`;
  if (hashed in item) return item[hashed];
  const bare = stripHash(bindingName);
  if (bare in item) return item[bare];
  return undefined;
}

/**
 * Parse a factory control ref (`battle.grid_button`, `@server_form.dynamic_button`).
 *
 * @param ref - Control reference string.
 * @param fallbackNs - Namespace when the ref has no dot.
 * @returns namespace + name, or null.
 */
export function parseControlRef(
  ref: string,
  fallbackNs: string,
): { namespace: string; name: string } | null {
  let s = ref.trim();
  if (!s) return null;
  if (s.startsWith("@")) s = s.slice(1);
  const dot = s.indexOf(".");
  if (dot < 0) return { namespace: fallbackNs, name: s };
  return { namespace: s.slice(0, dot), name: s.slice(dot + 1) };
}

/**
 * Resolve the factory template element for a collection host.
 *
 * Prefers `factory.control_name`; falls back to `factory.control_ids.button`.
 *
 * @param host - Element with `factory` + `collection_name`.
 * @param resolver - UI resolver.
 * @returns template element, or undefined.
 */
export function resolveFactoryTemplate(
  host: ResolvedElement,
  resolver: UiResolver,
): ResolvedElement | undefined {
  const factory = host.props.factory;
  if (!factory || typeof factory !== "object" || Array.isArray(factory)) {
    return undefined;
  }
  const f = factory as PropertyBag;
  let ref: string | undefined;
  if (typeof f.control_name === "string" && f.control_name) {
    ref = f.control_name;
  } else if (f.control_ids && typeof f.control_ids === "object") {
    const ids = f.control_ids as PropertyBag;
    if (typeof ids.button === "string") ref = ids.button;
  }
  if (!ref) return undefined;
  const parsed = parseControlRef(ref, host.namespace);
  if (!parsed) return undefined;
  return resolver.resolve(parsed.namespace, parsed.name);
}

/**
 * Resolve `grid_item_template` for a collection grid host.
 *
 * @param host - Grid element with `grid_item_template` + `collection_name`.
 * @param resolver - UI resolver.
 * @returns template element, or undefined.
 */
export function resolveGridItemTemplate(
  host: ResolvedElement,
  resolver: UiResolver,
): ResolvedElement | undefined {
  const ref = host.props.grid_item_template;
  if (typeof ref !== "string" || !ref) return undefined;
  const parsed = parseControlRef(ref, host.namespace);
  if (!parsed) return undefined;
  return resolver.resolve(parsed.namespace, parsed.name);
}

/**
 * Infer `[cols, rows]` when a grid omits `grid_dimensions`.
 *
 * Horizontal grids (starter picker) size cells from the template width
 * percent (`15%` → 6 columns). Falls back to 6×N to match PokeBedrock's
 * `ButtonsPerRow`.
 *
 * @param host - Grid host props.
 * @param template - Resolved item template.
 * @param itemCount - Collection length.
 * @returns column and row counts.
 */
export function inferGridDimensions(
  host: ResolvedElement,
  template: ResolvedElement,
  itemCount: number,
): [number, number] {
  const existing = host.props.grid_dimensions;
  if (Array.isArray(existing) && existing.length >= 2) {
    return [
      Math.max(1, Math.floor(Number(existing[0]) || 1)),
      Math.max(1, Math.floor(Number(existing[1]) || 1)),
    ];
  }
  let cols = 6;
  const size = template.props.size;
  if (Array.isArray(size) && typeof size[0] === "string") {
    const m = /^(\d+(?:\.\d+)?)%$/.exec(size[0].trim());
    if (m) {
      const pct = Number(m[1]);
      if (pct > 0) cols = Math.max(1, Math.floor(100 / pct));
    }
  }
  const rows = Math.max(1, Math.ceil(Math.max(itemCount, 1) / cols));
  return [cols, rows];
}

/**
 * Expand every `collection_name` + `factory` host in `el` into N children.
 * Does not apply bindings — call {@link bindResolvedTree} after.
 *
 * @param el - Root resolved element (mutated / replaced via return).
 * @param resolver - For factory template resolution.
 * @param collections - Named item lists.
 * @returns element with collection children instantiated.
 */
export function expandCollections(
  el: ResolvedElement,
  resolver: UiResolver,
  collections: CollectionMap,
): ResolvedElement {
  const out = cloneResolved(el);
  expandInPlace(out, resolver, collections);
  return out;
}

/**
 * Apply global + collection + view bindings, then materialize `#prop` refs.
 * Walks children; uses `scope` for collection-typed bindings.
 * Parent `$variables` inherit into children (Bedrock scope) so expressions
 * like `$bag_button_id` on a child resolve.
 *
 * @param el - Element to bind (mutated).
 * @param source - Global binding source.
 * @param collections - Named item lists.
 * @param scope - Active collection item, if any.
 * @param parentVars - Inherited `$…` variables from ancestors.
 */
export function bindResolvedTree(
  el: ResolvedElement,
  source: BindingSource,
  collections: CollectionMap,
  scope?: CollectionScope,
  parentVars: PropertyBag = {},
): void {
  const opts: ApplyBindingsOptions = {};
  if (scope) {
    const items = collections[scope.name] ?? [];
    const item = items[scope.index];
    opts.collectionIndex = scope.index;
    opts.collection = (collName, bindingName) => {
      if (collName !== scope.name || !item) return undefined;
      return readCollectionItem(item, bindingName);
    };
  }

  // Inherit parent $vars; local props win.
  const scopedProps: PropertyBag = { ...parentVars, ...el.props };
  const bindEl: ResolvedElement = { ...el, props: scopedProps };
  const out: PropertyBag = { ...scopedProps };
  // Collection / global first — view bindings that read sibling `#texture`
  // need children bound before they can resolve `source_control_name`.
  applyBindings(bindEl, source, out, { ...opts, viewsOnly: false });
  materializeHashProps(out, source, scope, collections);
  el.props = out;

  // Propagate collection_index onto the root of a factory instance for hover.
  if (scope && out.collection_index === undefined) {
    el.props.collection_index = scope.index;
  }

  const childVars = pickDollarVars(out);
  const childScope = factoryChildScope(el, collections, scope);
  for (const child of el.controls) {
    const nextScope =
      childScope !== undefined
        ? { name: childScope.name, index: childScope.indexFor(child) }
        : scope;
    bindResolvedTree(child.element, source, collections, nextScope, childVars);
  }

  const byControl = indexControls(el.controls);
  const resolveControl = (name: string): PropertyBag | undefined =>
    byControl.get(name);

  // Parent view bindings (e.g. panel_name ← child image.#texture).
  applyBindings(bindEl, source, out, {
    ...opts,
    viewsOnly: true,
    resolveControl,
  });
  el.props = out;

  // Re-run each child's view bindings with sibling scope (progress ← image).
  for (const child of el.controls) {
    const childOut = { ...child.element.props };
    applyBindings({ ...child.element, props: childOut }, source, childOut, {
      ...opts,
      viewsOnly: true,
      resolveControl,
    });
    child.element.props = childOut;
  }
}

/**
 * Index direct children by control id and element name for
 * `source_control_name` lookups.
 *
 * @param controls - Direct children.
 * @returns map of name → props.
 */
function indexControls(
  controls: readonly { id: string; element: ResolvedElement }[],
): Map<string, PropertyBag> {
  const map = new Map<string, PropertyBag>();
  for (const c of controls) {
    map.set(c.id, c.element.props);
    map.set(c.element.name, c.element.props);
  }
  return map;
}

/** @param props - Property bag. @returns only `$…` keys. */
function pickDollarVars(props: PropertyBag): PropertyBag {
  const out: PropertyBag = {};
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("$")) out[k] = v;
  }
  return out;
}

/**
 * Expand collections then bind the whole tree.
 *
 * @param el - Resolved root.
 * @param resolver - UI resolver.
 * @param source - Global bindings.
 * @param collections - Named collections.
 * @returns fully expanded + bound tree.
 */
export function prepareCollectionTree(
  el: ResolvedElement,
  resolver: UiResolver,
  source: BindingSource,
  collections: CollectionMap,
): ResolvedElement {
  const expanded = expandCollections(el, resolver, collections);
  bindResolvedTree(expanded, source, collections);
  return expanded;
}

/**
 * Count factory instances under `el` for a collection (test helper).
 *
 * @param el - Tree root.
 * @param collectionName - Collection to count.
 * @returns instance count (sum of direct factory children across hosts).
 */
export function countCollectionInstances(
  el: ResolvedElement,
  collectionName: string,
): number {
  let n = 0;
  const isHost =
    el.props.collection_name === collectionName &&
    (!!el.props.factory || typeof el.props.grid_item_template === "string");
  if (isHost) n += el.controls.length;
  for (const c of el.controls) {
    n += countCollectionInstances(c.element, collectionName);
  }
  return n;
}

/**
 * Collect bound `#form_button_text` values from nodes with a collection index.
 *
 * @param el - Tree root.
 * @returns texts keyed by collection index (first wins).
 */
export function collectFormButtonTexts(
  el: ResolvedElement,
): Map<number, string> {
  const out = new Map<number, string>();
  walk(el, (node) => {
    const idx = node.props.collection_index;
    const text = node.props.form_button_text;
    if (typeof idx === "number" && typeof text === "string" && !out.has(idx)) {
      out.set(idx, text);
    }
  });
  return out;
}

function expandInPlace(
  el: ResolvedElement,
  resolver: UiResolver,
  collections: CollectionMap,
): void {
  const collName =
    typeof el.props.collection_name === "string"
      ? el.props.collection_name
      : "";
  if (collName && el.props.factory) {
    const items = collections[collName] ?? [];
    const template = resolveFactoryTemplate(el, resolver);
    if (template) {
      const children: ResolvedChild[] = [];
      for (let i = 0; i < items.length; i++) {
        const inst = cloneResolved(template);
        inst.props = { ...inst.props, collection_index: i };
        expandInPlace(inst, resolver, collections);
        children.push({ id: `${inst.name}_${i}`, element: inst });
      }
      el.controls = children;
    }
  } else if (collName && typeof el.props.grid_item_template === "string") {
    // PokeBedrock starter picker: `picker_panel_grid` uses grid_item_template
    // + #maximum_grid_items, not a factory stack.
    const items = collections[collName] ?? [];
    const template = resolveGridItemTemplate(el, resolver);
    if (template) {
      const children: ResolvedChild[] = [];
      for (let i = 0; i < items.length; i++) {
        const inst = cloneResolved(template);
        inst.props = { ...inst.props, collection_index: i };
        expandInPlace(inst, resolver, collections);
        children.push({ id: `${inst.name}_${i}`, element: inst });
      }
      el.controls = children;
      const [cols, rows] = inferGridDimensions(el, template, items.length);
      el.props.grid_dimensions = [cols, rows];
    }
  }

  for (const child of el.controls) {
    expandInPlace(child.element, resolver, collections);
  }
}

/**
 * When `el` is a collection host that already has factory/grid children, map
 * each child id suffix / order to a collection index.
 */
function factoryChildScope(
  el: ResolvedElement,
  collections: CollectionMap,
  parentScope: CollectionScope | undefined,
): { name: string; indexFor(child: ResolvedChild): number } | undefined {
  const collName =
    typeof el.props.collection_name === "string"
      ? el.props.collection_name
      : "";
  const isHost =
    !!collName &&
    (!!el.props.factory || typeof el.props.grid_item_template === "string");
  if (!isHost) return undefined;
  const items = collections[collName] ?? [];
  return {
    name: collName,
    indexFor(child: ResolvedChild): number {
      const fromProps = child.element.props.collection_index;
      if (typeof fromProps === "number") return fromProps;
      const m = /_(\d+)$/.exec(child.id);
      if (m) return Number.parseInt(m[1]!, 10);
      const idx = el.controls.indexOf(child);
      return idx >= 0 && idx < items.length ? idx : (parentScope?.index ?? 0);
    },
  };
}

/**
 * Replace property values that are bare `#binding` refs with looked-up values.
 *
 * @param props - Property bag to mutate.
 * @param source - Global source.
 * @param scope - Optional collection scope.
 * @param collections - Named collections.
 */
function materializeHashProps(
  props: PropertyBag,
  source: BindingSource,
  scope: CollectionScope | undefined,
  collections: CollectionMap,
): void {
  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== "string") continue;
    if (!/^#[A-Za-z_][A-Za-z0-9_]*$/.test(value)) continue;
    let resolved: BindingValue | undefined;
    if (scope) {
      const item = collections[scope.name]?.[scope.index];
      if (item) resolved = readCollectionItem(item, value);
    }
    if (resolved === undefined) {
      resolved = source.global(value) ?? source.global(stripHash(value));
    }
    // Also allow already-written props (e.g. collection bind → form_button_text).
    if (resolved === undefined) {
      const fromProps = props[stripHash(value)] ?? props[value];
      if (
        typeof fromProps === "string" ||
        typeof fromProps === "number" ||
        typeof fromProps === "boolean"
      ) {
        resolved = fromProps;
      }
    }
    if (resolved !== undefined) props[key] = resolved;
  }
}

function walk(el: ResolvedElement, visit: (el: ResolvedElement) => void): void {
  visit(el);
  for (const c of el.controls) walk(c.element, visit);
}
