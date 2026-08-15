// Shared contract for the JSON UI engine. This file is the interface between
// the loader/resolver (load.ts, resolve.ts), the layout/DOM renderer
// (layout.ts, dom.ts) and the binding engine (expr.ts, bindings.ts) so the
// three halves can be built and tested independently. Extend types in your
// own module; changes to THIS file need all three halves updated together.
//
// The engine renders Bedrock JSON UI (ui/*.json) from the live pack stack —
// vanilla bedrock-samples at the bottom, the server's resource packs above,
// per `_ui_defs.json`. Reference: https://wiki.bedrock.dev/json-ui/json-ui-intro
// Same-named files in later packs do not replace earlier ones; each namespace
// accumulates element definitions and later packs override per-element (plus
// "modifications" arrays for surgical vanilla edits).

/** One ui/*.json document as authored: a namespace plus element definitions. */
export interface UiRawFile {
  /** The file's namespace ("hud", "common", server-custom names…). */
  namespace: string;
  /**
   * Every other top-level key is an element definition. Keys may carry an
   * inheritance suffix: "root_panel@common.base" or "foo@bar" (same-namespace).
   */
  elements: Record<string, PropertyBag>;
}

/** A ui file occurrence in one pack. Order in arrays = pack stack order (lowest first). */
export interface UiFileSource {
  packId: string;
  /** Pack-relative path, e.g. "ui/hud_screen.json". */
  path: string;
  raw: UiRawFile;
}

/** Arbitrary JSON UI property bag (unparsed element properties). */
export type PropertyBag = Record<string, unknown>;

/** Parsed element name: "root_panel@common.base" → name + base reference. */
export interface ElementName {
  name: string;
  base?: { namespace?: string; name: string };
}

/** A fully resolved element: base chain merged, $variables substituted. */
export interface ResolvedElement {
  /** Control type: panel | stack_panel | label | image | button | screen | input_panel | grid | scroll_view | custom | … */
  type: string;
  name: string;
  namespace: string;
  /** Merged properties (derived-most wins), $variables already substituted where literal. */
  props: PropertyBag;
  /** Ordered children from "controls" (each entry key "id@ref" resolved). */
  controls: ResolvedChild[];
  /** Raw "bindings" array, if any (evaluated later by the binding engine). */
  bindings: PropertyBag[];
}

export interface ResolvedChild {
  /** The per-instance id (left of @ in the controls entry key). */
  id: string;
  element: ResolvedElement;
}

/** Resolves "namespace.element" references against the loaded document set. */
export interface UiResolver {
  /** @param namespace Namespace to look in. @param name Element name. @returns the resolved element or undefined. */
  resolve(namespace: string, name: string): ResolvedElement | undefined;
  /** All screens (elements of type "screen") keyed "namespace.name". */
  screens(): string[];
}

/** A scalar a binding or expression evaluates to. */
export type BindingValue = string | number | boolean;

/**
 * Live game state the binding engine reads. Implemented over the SSE lanes
 * (title/phud/actor state); the engine itself stays pure.
 */
export interface BindingSource {
  /**
   * Global binding lookup, e.g. "#hud_title_text_string", "#hotbar_selected_slot",
   * "#player_health", "#form_button_text". Undefined = binding absent.
   */
  global(name: string): BindingValue | undefined;
}

/** Computed pixel rectangle for one element instance. */
export interface LayoutBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Viewport the screen lays out against (already gui-scaled pixels). */
export interface Viewport {
  width: number;
  height: number;
}
