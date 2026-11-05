/** Native hud_screen anim_chat_txt_alpha/bg_alpha: one-second in_quart fade. */
const CHAT_FADE_MS = 1_000;
/** Existing viewer setting; native chat duration options are 3, 10 and 30 sec. */
export const CHAT_HOLD_MS = 10_000;

/**
 * Chat alpha at an absolute presentation time. Film applies events with their
 * recorded tick clock, so seeking past a message must also seek past its fade.
 */
export function chatOpacity(bornMs: number, nowMs: number): number {
  const progress = (nowMs - bornMs - CHAT_HOLD_MS) / CHAT_FADE_MS;
  if (progress <= 0) return 1;
  if (progress >= 1) return 0;
  return 1 - progress ** 4;
}

/**
 * Resolve an explicitly marked legacy translation after languages load.
 * Recorder fallback joined parameters with spaces; only zero/one-argument
 * templates can be recovered without guessing where multiple arguments split.
 */
export function localizeChatText(
  text: string,
  lang: Readonly<Record<string, string>> | undefined,
): string {
  if (!lang) return text;
  const match = /^((?:§.|&.)*)%([A-Za-z0-9_.]+)(?: (.*))?$/.exec(text);
  if (!match) return text;
  const template = lang[match[2]!];
  if (template === undefined) return text;
  const placeholders = [...template.matchAll(/%(?:(\d+)\$)?s/g)];
  if (
    placeholders.some((p) => p[1] !== undefined && p[1] !== "1") ||
    placeholders.filter((p) => p[1] === undefined).length > 1 ||
    (placeholders.length === 0 && match[3]) ||
    (placeholders.length > 0 && match[3] === undefined)
  )
    return text;
  return match[1]! + template.replace(/%(?:1\$)?s/g, () => match[3] ?? "");
}
