/**
 * Parse Bedrock `animations/*.animation.json` documents.
 *
 * Schema: actor_animation 1.8.0 (Microsoft Learn). Units match geometry:
 * position in 1/16-block model units; rotation in degrees (extrinsic XYZ).
 */

/** Channel axis expression — number literal or Molang string. */
export type ChannelExpr = number | string;

/** One keyframe on a bone channel. */
export interface AnimKeyframe {
  time: number;
  /** Value when arriving at this stamp (from previous key). */
  pre: [ChannelExpr, ChannelExpr, ChannelExpr];
  /** Value when leaving this stamp (toward next key). */
  post: [ChannelExpr, ChannelExpr, ChannelExpr];
  /**
   * Interpolation used on the segment ending at this key.
   * Schema: `lerp_mode` `"linear"` | `"catmullrom"` (MS Learn actor_animation 1.8.0).
   * Older bedrock.dev text claimed "only linear" — schema wins.
   */
  lerpMode: "linear" | "catmullrom";
}

/** Static or keyframed channel on one bone. */
export interface AnimChannel {
  /** Constant value (no keyframes) — evaluated every sample. */
  constant?: [ChannelExpr, ChannelExpr, ChannelExpr];
  keyframes: AnimKeyframe[];
}

/** Per-bone channels inside an animation. */
export interface AnimBoneChannels {
  position?: AnimChannel;
  rotation?: AnimChannel;
  scale?: AnimChannel;
}

/** Normalised animation definition. */
export interface ParsedAnimation {
  identifier: string;
  /** `true` = wrap, `false` = play once then stop contributing, hold = clamp. */
  loop: boolean | "hold_on_last_frame";
  animTimeUpdate?: string;
  blendWeight?: string;
  startDelay?: string;
  loopDelay?: string;
  /** Seconds; defaults to last keyframe time (or 0). */
  animationLength: number;
  overridePrevious: boolean;
  bones: Map<string, AnimBoneChannels>;
}

/**
 * Parse an animations JSON document into identifier → def.
 *
 * @param input - Parsed JSON.
 * @returns map of animation identifiers.
 */
export function parseAnimations(input: unknown): Map<string, ParsedAnimation> {
  const out = new Map<string, ParsedAnimation>();
  if (!isObject(input)) return out;
  const root = input.animations;
  if (!isObject(root)) return out;
  for (const [id, raw] of Object.entries(root)) {
    if (!id || !isObject(raw)) continue;
    out.set(id, parseOneAnimation(id, raw));
  }
  return out;
}

/**
 * @param identifier - Animation name.
 * @param raw - Animation object.
 * @returns normalised def.
 */
function parseOneAnimation(
  identifier: string,
  raw: Record<string, unknown>,
): ParsedAnimation {
  const bones = new Map<string, AnimBoneChannels>();
  const bonesRaw = raw.bones;
  let lastKey = 0;
  if (isObject(bonesRaw)) {
    for (const [boneName, boneRaw] of Object.entries(bonesRaw)) {
      if (!boneName || !isObject(boneRaw)) continue;
      const channels: AnimBoneChannels = {};
      const pos = parseChannel(boneRaw.position);
      const rot = parseChannel(boneRaw.rotation);
      const scl = parseChannel(boneRaw.scale);
      if (pos) {
        channels.position = pos;
        lastKey = Math.max(lastKey, channelEnd(pos));
      }
      if (rot) {
        channels.rotation = rot;
        lastKey = Math.max(lastKey, channelEnd(rot));
      }
      if (scl) {
        channels.scale = scl;
        lastKey = Math.max(lastKey, channelEnd(scl));
      }
      bones.set(boneName, channels);
    }
  }

  const lengthRaw = raw.animation_length;
  const animationLength =
    typeof lengthRaw === "number" && Number.isFinite(lengthRaw) && lengthRaw > 0
      ? lengthRaw
      : lastKey;

  return {
    identifier,
    loop: parseLoop(raw.loop),
    animTimeUpdate: asMolangString(raw.anim_time_update),
    blendWeight: asMolangString(raw.blend_weight),
    startDelay: asMolangString(raw.start_delay),
    loopDelay: asMolangString(raw.loop_delay),
    animationLength,
    overridePrevious: raw.override_previous_animation === true,
    bones,
  };
}

/**
 * @param loop - Raw loop field.
 * @returns normalised loop mode.
 */
function parseLoop(loop: unknown): boolean | "hold_on_last_frame" {
  if (loop === true) return true;
  if (loop === "hold_on_last_frame") return "hold_on_last_frame";
  return false;
}

/**
 * @param raw - Channel value (scalar / vec / keyframe map).
 * @returns channel or undefined when absent.
 */
function parseChannel(raw: unknown): AnimChannel | undefined {
  if (raw === undefined || raw === null) return undefined;

  // Constant: number | [x,y,z] | molang string
  if (typeof raw === "number" || typeof raw === "string") {
    const v = expandTriple(raw);
    return { constant: v, keyframes: [] };
  }
  if (Array.isArray(raw)) {
    return { constant: expandTriple(raw), keyframes: [] };
  }
  if (!isObject(raw)) return undefined;

  // Keyframe map: { "0.0": [...], "0.5": { pre, post, lerp_mode } }
  const keyframes: AnimKeyframe[] = [];
  for (const [timeStr, kfRaw] of Object.entries(raw)) {
    const time = Number(timeStr);
    if (!Number.isFinite(time)) continue;
    keyframes.push(parseKeyframe(time, kfRaw));
  }
  keyframes.sort((a, b) => a.time - b.time);
  if (keyframes.length === 0) return undefined;
  return { keyframes };
}

/**
 * @param time - Keyframe stamp (seconds).
 * @param raw - Array or {pre,post,lerp_mode}.
 * @returns keyframe.
 */
function parseKeyframe(time: number, raw: unknown): AnimKeyframe {
  if (
    typeof raw === "number" ||
    typeof raw === "string" ||
    Array.isArray(raw)
  ) {
    const v = expandTriple(raw);
    return { time, pre: v, post: v, lerpMode: "linear" };
  }
  if (!isObject(raw)) {
    return { time, pre: [0, 0, 0], post: [0, 0, 0], lerpMode: "linear" };
  }
  const mode =
    raw.lerp_mode === "catmullrom" || raw.lerp_mode === "smooth"
      ? "catmullrom"
      : "linear";
  // "smooth" is Blockbench's export alias for catmullrom (schema name).
  const postRaw = raw.post ?? raw.pre ?? [0, 0, 0];
  const preRaw = raw.pre ?? raw.post ?? [0, 0, 0];
  // When only a bare triple sits under the stamp, treat as both pre+post.
  if (
    raw.pre === undefined &&
    raw.post === undefined &&
    raw.lerp_mode === undefined
  ) {
    // Might be a mistaken nest — fall through using zeros unless array-like keys.
  }
  // Discontinuous: missing pre → use post (and vice versa) per common pack authoring.
  const hasPre = raw.pre !== undefined;
  const hasPost = raw.post !== undefined;
  if (!hasPre && !hasPost) {
    // Object with only lerp_mode? unlikely — try array fields.
    const asArr = Object.keys(raw).every(
      (k) => k === "0" || k === "1" || k === "2",
    );
    if (asArr) {
      const v = expandTriple([raw["0"], raw["1"], raw["2"]]);
      return { time, pre: v, post: v, lerpMode: mode };
    }
  }
  return {
    time,
    pre: expandTriple(hasPre ? preRaw : postRaw),
    post: expandTriple(hasPost ? postRaw : preRaw),
    lerpMode: mode,
  };
}

/**
 * Expand scalar / 1-length / 3-length into an XYZ triple.
 * Uniform scalar → [v,v,v] (MS Learn: scale/rotation/position shorthand).
 *
 * @param raw - Scalar, string, or array.
 * @returns XYZ expressions.
 */
export function expandTriple(
  raw: unknown,
): [ChannelExpr, ChannelExpr, ChannelExpr] {
  if (typeof raw === "number" || typeof raw === "string") {
    return [raw, raw, raw];
  }
  if (!Array.isArray(raw) || raw.length === 0) return [0, 0, 0];
  if (raw.length === 1) {
    const v = asExpr(raw[0]);
    return [v, v, v];
  }
  return [asExpr(raw[0]), asExpr(raw[1] ?? 0), asExpr(raw[2] ?? 0)];
}

/**
 * @param v - Unknown.
 * @returns channel expression.
 */
function asExpr(v: unknown): ChannelExpr {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return 0;
}

/**
 * @param ch - Channel.
 * @returns last keyframe time (0 for constants).
 */
function channelEnd(ch: AnimChannel): number {
  if (ch.keyframes.length === 0) return 0;
  return ch.keyframes[ch.keyframes.length - 1]!.time;
}

/**
 * @param v - Unknown.
 * @returns molang string or undefined.
 */
function asMolangString(v: unknown): string | undefined {
  if (typeof v === "string" && v) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

/**
 * @param v - Unknown.
 * @returns true for plain objects.
 */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
