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
 * | XP | `#exp_progress`, `#level_number` | |
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
   * Collection-scoped lookup for `binding_type: "collection"`.
   * Called with the collection name and binding name (with or without `#`).
   */
  collection?: (
    collectionName: string,
    bindingName: string,
  ) => BindingValue | undefined;
  /** Current `#collection_index` for `binding_type: "collection_details"`. */
  collectionIndex?: number;
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
  if (`$${name}` in props) return props[`$${name}`];
  if (name in props) return props[name];
  return undefined;
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

  for (const raw of element.bindings) {
    if (raw.ignored === true) continue;

    // Parse condition for future use; treat all as always for now.
    const _condition =
      (raw.binding_condition as BindingCondition | undefined) ?? "always";
    void _condition;

    const type = (raw.binding_type as string | undefined) ?? "global";

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

      // source_control_name / resolve_sibling_scope: integration fills `lookup`.
      // When source is a bare property ref like `#sidebar`, eval still works.

      const expanded = expandBareVariable(sourceProp, props);
      let value: BindingValue;
      try {
        value = evalExpr(parseExpr(expanded), scope);
      } catch {
        continue;
      }
      writeTarget(out, targetProp, value);
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
