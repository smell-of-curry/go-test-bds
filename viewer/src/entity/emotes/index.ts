/** Native persona animations imported locally; no synthetic motion fallback. */
import { parseAnimations, type ParsedAnimation } from "../parseAnimation";

export const WAVE_EMOTE_ID = "4c8ae710-df2e-47cd-814d-cc7bf21a3d67";
const TABLE = new Map<string, ParsedAnimation>();

/** Replace the registry atomically. IDs and animation names come from native metadata. */
export function registerNativeEmotes(input: unknown): number {
  const data = input as {
    schemaVersion?: number;
    emotes?: Array<{ id: string; animationName: string; document: unknown }>;
  };
  if (data?.schemaVersion !== 1 || !Array.isArray(data.emotes)) {
    throw new Error("Invalid native emote dataset");
  }
  const next = new Map<string, ParsedAnimation>();
  for (const entry of data.emotes) {
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(entry.id)) {
      throw new Error("Invalid native emote UUID");
    }
    const anim = parseAnimations(entry.document).get(entry.animationName);
    const id = entry.id.toLowerCase();
    if (
      !anim ||
      anim.bones.size === 0 ||
      !(anim.animationLength > 0) ||
      next.has(id)
    ) {
      throw new Error(`Invalid or duplicate native emote: ${id}`);
    }
    next.set(id, anim);
  }
  TABLE.clear();
  for (const [id, animation] of next) TABLE.set(id, animation);
  return TABLE.size;
}

/** Unknown/unavailable emotes deliberately contribute no pose. */
export function builtinEmote(id: string): ParsedAnimation | null {
  return TABLE.get(id.trim().toLowerCase()) ?? null;
}
