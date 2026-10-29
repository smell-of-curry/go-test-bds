/**
 * Built-in persona emotes.
 *
 * Exception to the pack-source-of-truth invariant: Bedrock emotes are persona
 * marketplace content. They are not in any resource pack (vanilla baseline or
 * server), so the viewer cannot resolve them from `/asset`. This table is the
 * only hardcoded animation. Unknown ids do nothing.
 *
 * Wave (`4c8ae710-df2e-47cd-814d-cc7bf21a3d67`) raises `rightArm` (and the
 * legacy `rightarm` alias) and swings it on Z for ~2.5 s, then eases back to
 * rest by 3.0 s. `loop: false` — past 3 s the sampler stops contributing and
 * the idle/walk pose returns.
 */

import waveDoc from "./wave.json" with { type: "json" };
import { parseAnimations, type ParsedAnimation } from "../parseAnimation";

/** Vanilla "Wave" persona emote. */
export const WAVE_EMOTE_ID = "4c8ae710-df2e-47cd-814d-cc7bf21a3d67";

/** Seconds the wave contributes before the arm returns to idle. */
export const EMOTE_DURATION_SEC = 3;

const TABLE = new Map<string, ParsedAnimation>();

for (const anim of parseAnimations(waveDoc).values()) {
  TABLE.set(WAVE_EMOTE_ID, anim);
}

/**
 * @param id - Emote UUID from the entity snapshot.
 * @returns parsed animation, or null when this viewer has no built-in for it.
 */
export function builtinEmote(id: string): ParsedAnimation | null {
  const key = id.trim().toLowerCase();
  return TABLE.get(key) ?? null;
}
