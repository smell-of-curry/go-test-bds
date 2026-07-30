/**
 * Apply Bedrock JSON UI bindings onto a resolved element's property map.
 *
 * ## Standard global bindings the engine expects (wire later from SSE/title)
 *
 * From vanilla `testdata/jsonui/vanilla/hud_screen.json` + PokeBedrock PHUD:
 *
 * | Role | Real binding name | Notes |
 * |---|---|---|
 * | Title text | `#hud_title_text_string` | PHUD control channel (`&_…`) |
 * | Subtitle text | `#hud_subtitle_text_string` | |
 * | Hotbar selection | `#slot_selected` | **collection** on `$hotbar_collection_name`, not a scalar `#hotbar_selected_slot` |
 * | Hearts | *(none — `heart_renderer`)* | Custom renderer; no `#player_health` in hud_screen |
 * | Hunger | *(none — `hunger_renderer`)* | Custom renderer; no `#hunger` / `#food` scalar |
 * | Title visibility helpers | — | PokeBedrock derives via view expr on title string |
 * | Common HUD toggles | `#hotbar_visible`, `#show_survival_ui`, `#hud_visible_centered`, … | |
 * | Hotbar item slots | collection `hotbar_items` / `#inventory_stack_count`, … | collection bindings — not implemented here |
 * | Player position / days | `#player_position_text`, `#number_of_days_played_text` | |
 * | Chat | `#chat_text` | |
 * | XP | `#exp_progress`, `#level_number`, `#level_number_visible` | visible only when level > 0 |
 * | Hotbar mode | `#hotbar_with_xp_bar` / `#hotbar_no_xp_bar` / `#hotbar_with_locator_bar` | mutually exclusive |
 * | Touch ellipses | `#hotbar_elipses_left_visible` / `#hotbar_elipses_right_visible` | off on desktop |
 *
 * PokeBedrock also synthesizes view-scoped properties (`#sidebar`, `#phone`,
 * `#player_ping_text`) by slicing `#hud_title_text_string` upstream of these
 * elements — integration owns that fan-out.
 */

import { evalExpr, parseExpr, type ExprScope } from "./expr.js";
import type {
  BindingSource,
  BindingValue,
  PropertyBag,
  ResolvedElement,
} from "./types.js";

/**
 * True when a view-binding target gates show/enable — failed / missing
 * conditions must collapse the control (default-visible would leak HUD chrome).
 *
 * @param target - `target_property_name` (`#visible` / `visible` / …).
 * @returns whether to coerce failures to `false`.
 */
function isVisibilityGateTarget(target: string): boolean {
  const name = stripHash(target);
  return name === "visible" || name === "enabled";
}

/**
 * Coerce a bound visibility/enabled value to a real boolean.
 *
 * Layout treats anything other than strict `false` as visible, so writing
 * `""` from a failed string expr would still paint.
 *
 * @param value - Raw eval result.
 * @returns boolean gate.
 */
function asVisibilityGate(value: BindingValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return value !== "";
}

/** Binding condition values seen in packs; currently all treated as always. */
export type BindingCondition =
  | "always"
  | "visible"
  | "once"
  | "none"
  | "always_when_visible"
  | "visibility_changed"
  | string;

export interface ApplyBindingsOptions {
  /**
   * Extra `#name` lookups beyond already-written `out` properties (parent /
   * sibling / collection scope). Called with the name **without** `#`.
   */
  lookup?: (name: string) => BindingValue | undefined;
  /**
   * Resolve a `source_control_name` target to its bound property bag
   * (sibling / child control). Used by view bindings with
   * `resolve_sibling_scope`.
   *
   * @param controlName - Leaf control id / name (e.g. `"image"`).
   * @returns that control's props, or undefined.
   */
  resolveControl?: (controlName: string) => PropertyBag | undefined;
  /**
   * Collection-scoped lookup for `binding_type: "collection"`.
   * Called with the collection name and binding name (with or without `#`).
   */
  collection?: (
    collectionName: string,
    bindingName: string,
  ) => BindingValue | undefined;
  /** Current `#collection_index` for `binding_type: "collection_details"`. */
  collectionIndex?: number;
  /**
   * When true, only `binding_type: "view"` entries run. When false, view
   * bindings are skipped (collection/global/`collection_details` only).
   * Default: run every binding.
   */
  viewsOnly?: boolean;
}

/**
 * Strip a leading `#` from a property / binding name.
 *
 * @param name Raw name, e.g. `#text` or `text`.
 * @returns Name without a leading `#`.
 */
export function stripHash(name: string): string {
  return name.startsWith("#") ? name.slice(1) : name;
}

/**
 * Strip a leading `$` from a variable name.
 *
 * @param name Raw name, e.g. `$var_size` or `var_size`.
 * @returns Name without a leading `$`.
 */
export function stripDollar(name: string): string {
  return name.startsWith("$") ? name.slice(1) : name;
}

/**
 * Resolve a `$variable` from an element property bag (props may store keys
 * with or without the `$` prefix after resolve-time substitution).
 *
 * @param props Element property map.
 * @param name Variable name without `$`.
 * @returns Stored value, or undefined.
 */
function readVariable(props: PropertyBag, name: string): unknown {
  let v: unknown =
    `$${name}` in props
      ? props[`$${name}`]
      : name in props
        ? props[name]
        : undefined;
  // Chase `$alias` (sidebar `$var_index` → `$pokemon_id_index` → number).
  for (
    let i = 0;
    i < 8 && typeof v === "string" && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v);
    i++
  ) {
    const next = props[v] ?? props[v.slice(1)];
    if (next === undefined || next === v) break;
    v = next;
  }
  return v;
}

/**
 * If `src` is a bare `$var` whose value is a string, expand it once (macro).
 * This is how `$string_parser` becomes the real field-extraction expression.
 *
 * @param src Source property expression.
 * @param props Element props for variable lookup.
 * @returns Expanded expression source.
 */
function expandBareVariable(src: string, props: PropertyBag): string {
  const m = src.trim().match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!m) return src;
  const v = readVariable(props, m[1]!);
  return typeof v === "string" ? v : src;
}

/**
 * True when `binding_name` should be evaluated as an expression rather than
 * looked up as a global key (e.g. `(not #is_spectator_mode)`).
 *
 * @param name binding_name string.
 * @returns Whether to parse+eval.
 */
function isExprBindingName(name: string): boolean {
  const t = name.trim();
  if (t.startsWith("(") || t.includes(" ")) return true;
  if (/^(not|and|or)\b/.test(t)) return true;
  return false;
}

/**
 * Build an expression scope over globals, already-bound element properties,
 * optional parent/sibling lookup, and element `$variables`.
 *
 * @param source Live global binding source.
 * @param out Current property map being filled.
 * @param props Element props (for `$variables`).
 * @param lookup Optional sibling/parent `#property` callback.
 * @returns Scope for {@link evalExpr}.
 */
function makeScope(
  source: BindingSource,
  out: PropertyBag,
  props: PropertyBag,
  lookup?: (name: string) => BindingValue | undefined,
): ExprScope {
  return {
    binding(name: string): BindingValue | undefined {
      const fromOut = out[name];
      if (
        typeof fromOut === "string" ||
        typeof fromOut === "number" ||
        typeof fromOut === "boolean"
      ) {
        return fromOut;
      }
      const hashed = out[`#${name}`];
      if (
        typeof hashed === "string" ||
        typeof hashed === "number" ||
        typeof hashed === "boolean"
      ) {
        return hashed;
      }
      if (lookup) {
        const v = lookup(name);
        if (v !== undefined) return v;
      }
      // Fall back to globals so view exprs can read `#hud_title_text_string`.
      return source.global(`#${name}`) ?? source.global(name);
    },
    variable(name: string): unknown {
      return readVariable(props, name);
    },
  };
}

/**
 * Write a bound value onto `out` under the unprefixed property key.
 *
 * @param out Destination property map.
 * @param target Target name (`#text` or `text`).
 * @param value Value to store.
 */
function writeTarget(
  out: PropertyBag,
  target: string,
  value: BindingValue,
): void {
  out[stripHash(target)] = value;
}

/**
 * Read a binding value from a control property bag (`texture` / `#texture`).
 *
 * @param props - Control props.
 * @param name - Name without `#`.
 * @returns bound value, or undefined.
 */
function readControlProp(
  props: PropertyBag,
  name: string,
): BindingValue | undefined {
  const v = props[name] ?? props[`#${name}`];
  if (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  ) {
    return v;
  }
  return undefined;
}

/**
 * Apply an element's bindings array onto a property map.
 *
 * Supports:
 * - `binding_type: "global"` (default): look up `binding_name` on `source`,
 *   write to `binding_name_override` (or `binding_name` if unset).
 * - `binding_type: "view"`: evaluate `source_property_name` with `#…` refs
 *   resolving against already-bound `out` properties / `lookup`, write to
 *   `target_property_name`.
 *
 * `binding_condition` is parsed but currently always applied (`always`).
 * `collection` / `collection_details` need {@link ApplyBindingsOptions.collection}
 * / `collectionIndex`; without those opts they are skipped (prior behaviour).
 *
 * @param element Resolved element (bindings + props for `$variables`).
 * @param source Live global binding source.
 * @param out Property map to mutate / extend (typically a copy of props).
 * @param opts Optional sibling/parent / collection lookup.
 * @returns The same `out` map for chaining.
 */
export function applyBindings(
  element: ResolvedElement,
  source: BindingSource,
  out: PropertyBag,
  opts?: ApplyBindingsOptions,
): PropertyBag {
  const props = element.props;
  const scope = makeScope(source, out, props, opts?.lookup);

  const viewsOnly = opts?.viewsOnly === true;

  for (const raw of element.bindings) {
    if (raw.ignored === true) continue;

    // Parse condition for future use; treat all as always for now.
    const _condition =
      (raw.binding_condition as BindingCondition | undefined) ?? "always";
    void _condition;

    const type = (raw.binding_type as string | undefined) ?? "global";

    if (viewsOnly && type !== "view") continue;
    if (!viewsOnly && opts?.viewsOnly === false && type === "view") continue;

    if (type === "collection_details") {
      if (opts?.collectionIndex === undefined) continue;
      writeTarget(out, "#collection_index", opts.collectionIndex);
      continue;
    }

    if (type === "collection") {
      if (!opts?.collection) continue;
      const collName = raw.binding_collection_name;
      if (typeof collName !== "string" || !collName) continue;
      const bindName = raw.binding_name;
      if (typeof bindName !== "string") continue;
      if (bindName === "#null" || bindName === "null") continue;
      const override =
        typeof raw.binding_name_override === "string"
          ? raw.binding_name_override
          : bindName;
      const value = opts.collection(collName, bindName);
      if (value === undefined) continue;
      writeTarget(out, override, value);
      continue;
    }

    if (type === "none") continue;

    if (type === "view") {
      const sourceProp = raw.source_property_name;
      const targetProp = raw.target_property_name;
      if (typeof sourceProp !== "string" || typeof targetProp !== "string")
        continue;

      const ctrl =
        typeof raw.source_control_name === "string"
          ? raw.source_control_name
          : "";
      // When a control index is in play, missing names mean "wrong scope"
      // (parent re-applying a grandchild binding) — leave the target alone
      // instead of fail-closing #visible.
      let sib: PropertyBag | undefined;
      if (ctrl && opts?.resolveControl) {
        sib = opts.resolveControl(ctrl);
        if (!sib) continue;
      }
      const viewScope = makeScope(source, out, props, (name) => {
        if (sib) {
          const fromSib = readControlProp(sib, name);
          if (fromSib !== undefined) return fromSib;
        }
        return opts?.lookup?.(name);
      });

      const gate = isVisibilityGateTarget(targetProp);
      const expanded = expandBareVariable(sourceProp, props);
      // Unresolved `$condition` (or similar) macro — hide, don't default-show.
      if (
        gate &&
        /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(sourceProp.trim()) &&
        expanded.trim() === sourceProp.trim()
      ) {
        writeTarget(out, targetProp, false);
        continue;
      }

      let value: BindingValue;
      try {
        value = evalExpr(parseExpr(expanded), viewScope);
      } catch {
        if (gate) writeTarget(out, targetProp, false);
        continue;
      }
      writeTarget(out, targetProp, gate ? asVisibilityGate(value) : value);
      continue;
    }

    // global (default)
    const bindName = raw.binding_name;
    if (typeof bindName !== "string") continue;
    if (bindName === "#null" || bindName === "null") continue;

    const override =
      typeof raw.binding_name_override === "string"
        ? raw.binding_name_override
        : bindName;

    let value: BindingValue | undefined;
    if (isExprBindingName(bindName)) {
      try {
        value = evalExpr(parseExpr(bindName), scope);
      } catch {
        continue;
      }
    } else {
      value = source.global(bindName);
      if (value === undefined) value = source.global(stripHash(bindName));
    }
    if (value === undefined) continue;
    writeTarget(out, override, value);
  }

  return out;
}
