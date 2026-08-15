/**
 * Parse Bedrock `animation_controllers/*.json` documents.
 *
 * Semantics (MS Learn Animation Controllers / bedrock.dev):
 * - Transitions evaluated in order; first non-zero wins; one transition/frame.
 * - `blend_transition` on the *leaving* state = cross-fade duration (seconds).
 * - State `animations` entries are short names or `{ name: weightMolang }`.
 */

/** One animation entry in a controller state. */
export interface ControllerAnimRef {
  name: string;
  /** Blend weight Molang; omit → 1. */
  weight?: string;
}

/** Transition: target state + condition Molang. */
export interface ControllerTransition {
  target: string;
  condition: string;
}

/** Remap curve for a state variable. */
export interface ControllerVariable {
  input: string;
  remapCurve: Array<{ in: number; out: number }>;
}

/** One state inside a controller. */
export interface ControllerState {
  name: string;
  animations: ControllerAnimRef[];
  transitions: ControllerTransition[];
  /** Seconds to cross-fade when *leaving* this state. */
  blendTransition: number;
  variables: Record<string, ControllerVariable>;
}

/** Parsed `controller.animation.*` entry. */
export interface ParsedAnimController {
  identifier: string;
  initialState: string;
  states: Map<string, ControllerState>;
}

/**
 * Parse an animation_controllers JSON document.
 *
 * @param input - Parsed JSON.
 * @returns map of controller identifiers.
 */
export function parseAnimControllers(
  input: unknown,
): Map<string, ParsedAnimController> {
  const out = new Map<string, ParsedAnimController>();
  if (!isObject(input)) return out;
  const root = input.animation_controllers;
  if (!isObject(root)) return out;
  for (const [id, raw] of Object.entries(root)) {
    if (!id || !isObject(raw)) continue;
    out.set(id, parseOneController(id, raw));
  }
  return out;
}

/**
 * @param identifier - Controller name.
 * @param raw - Controller object.
 * @returns normalised controller.
 */
function parseOneController(
  identifier: string,
  raw: Record<string, unknown>,
): ParsedAnimController {
  const states = new Map<string, ControllerState>();
  const statesRaw = raw.states;
  if (isObject(statesRaw)) {
    for (const [name, stateRaw] of Object.entries(statesRaw)) {
      if (!name || !isObject(stateRaw)) continue;
      states.set(name, parseState(name, stateRaw));
    }
  }

  let initialState =
    typeof raw.initial_state === "string" && raw.initial_state
      ? raw.initial_state
      : "default";
  if (!states.has(initialState)) {
    // Fall back to first state when `default` / initial_state missing.
    const first = states.keys().next().value;
    if (first) initialState = first;
  }

  return { identifier, initialState, states };
}

/**
 * @param name - State name.
 * @param raw - State object.
 * @returns normalised state.
 */
function parseState(
  name: string,
  raw: Record<string, unknown>,
): ControllerState {
  const blend =
    typeof raw.blend_transition === "number" &&
    Number.isFinite(raw.blend_transition)
      ? Math.max(0, raw.blend_transition)
      : 0;

  return {
    name,
    animations: parseAnimList(raw.animations),
    transitions: parseTransitions(raw.transitions),
    blendTransition: blend,
    variables: parseVariables(raw.variables),
  };
}

/**
 * @param list - State animations array.
 * @returns refs.
 */
function parseAnimList(list: unknown): ControllerAnimRef[] {
  if (!Array.isArray(list)) return [];
  const out: ControllerAnimRef[] = [];
  for (const entry of list) {
    if (typeof entry === "string" && entry) {
      out.push({ name: entry });
      continue;
    }
    if (!isObject(entry)) continue;
    for (const [n, w] of Object.entries(entry)) {
      if (!n) continue;
      out.push({
        name: n,
        weight: typeof w === "string" ? w : String(w),
      });
    }
  }
  return out;
}

/**
 * @param list - Transitions array.
 * @returns transitions in authoring order.
 */
function parseTransitions(list: unknown): ControllerTransition[] {
  if (!Array.isArray(list)) return [];
  const out: ControllerTransition[] = [];
  for (const entry of list) {
    if (!isObject(entry)) continue;
    for (const [target, cond] of Object.entries(entry)) {
      if (!target) continue;
      out.push({
        target,
        condition: typeof cond === "string" ? cond : String(cond),
      });
    }
  }
  return out;
}

/**
 * @param raw - State variables object.
 * @returns remap variables.
 */
function parseVariables(raw: unknown): Record<string, ControllerVariable> {
  if (!isObject(raw)) return {};
  const out: Record<string, ControllerVariable> = {};
  for (const [name, v] of Object.entries(raw)) {
    if (!name || !isObject(v)) continue;
    const input = typeof v.input === "string" ? v.input : "";
    const curveRaw = v.remap_curve;
    const remapCurve: Array<{ in: number; out: number }> = [];
    if (isObject(curveRaw)) {
      for (const [inStr, outVal] of Object.entries(curveRaw)) {
        const inn = Number(inStr);
        const outn = typeof outVal === "number" ? outVal : Number(outVal);
        if (Number.isFinite(inn) && Number.isFinite(outn)) {
          remapCurve.push({ in: inn, out: outn });
        }
      }
      remapCurve.sort((a, b) => a.in - b.in);
    }
    out[name] = { input, remapCurve };
  }
  return out;
}

/**
 * @param v - Unknown.
 * @returns true for plain objects.
 */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
