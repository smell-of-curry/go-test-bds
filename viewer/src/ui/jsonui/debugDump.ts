/**
 * Capture-harness dump of visible JSON UI nodes (live ground truth).
 * Cheap DOM walk — no layout recompute.
 */

/** One visible (or paint-contributing) JSON UI node. */
export interface JsonUiDumpElement {
  /** `namespace.name` from `data-jsonui-name`. */
  name: string;
  /** Ancestor chain of `data-jsonui-name` values (root → leaf). */
  path: string;
  /** `data-ui-type` (image / label / panel / …). */
  type: string;
  /** CSS pixel bounding rect relative to the viewport. */
  rect: { x: number; y: number; w: number; h: number };
  opacity: number;
  visibility: string;
  display: string;
  zIndex: string;
  /** Face / host background-image URL (texture). */
  backgroundImage: string;
  backgroundColor: string;
  backgroundSize: string;
  backgroundPosition: string;
  /** Trimmed textContent (labels); empty for pure images. */
  text: string;
}

/** Full dump payload written next to each still. */
export interface JsonUiDump {
  tick: number;
  viewport: { w: number; h: number };
  /** Live PHUD token → value map from the SSE store. */
  phud: Record<string, string>;
  /** Visible JSON UI nodes, largest area first (easier black-box hunting). */
  elements: JsonUiDumpElement[];
}

/**
 * Walk the mounted JSON UI host and list every visible node.
 *
 * @param host - `.jsonui-hud-host` (or `#json-hud`) root.
 * @param tick - Current world tick.
 * @param phud - Live PHUD map.
 * @returns dump payload.
 */
export function collectJsonUiDump(
  host: HTMLElement | null,
  tick: number,
  phud: ReadonlyMap<string, string>,
): JsonUiDump {
  const phudObj: Record<string, string> = {};
  for (const [k, v] of phud) phudObj[k] = v;

  const viewport = { w: window.innerWidth, h: window.innerHeight };
  if (!host) {
    return { tick, viewport, phud: phudObj, elements: [] };
  }

  const elements: JsonUiDumpElement[] = [];
  const nodes = host.querySelectorAll<HTMLElement>(".jsonui[data-jsonui-name]");
  for (const el of nodes) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const opacity = Number(cs.opacity);
    if (!(opacity > 0.01)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    // Skip fully off-screen (still keep overhanging dock pieces).
    if (
      r.right < 0 ||
      r.bottom < 0 ||
      r.left > viewport.w ||
      r.top > viewport.h
    )
      continue;

    const face = el.querySelector(
      ":scope > .jsonui-image-face",
    ) as HTMLElement | null;
    const faceCs = face ? getComputedStyle(face) : null;
    const backgroundImage =
      face?.style.backgroundImage ||
      faceCs?.backgroundImage ||
      el.style.backgroundImage ||
      cs.backgroundImage ||
      "none";
    const backgroundColor =
      face?.style.backgroundColor ||
      faceCs?.backgroundColor ||
      el.style.backgroundColor ||
      cs.backgroundColor ||
      "transparent";
    const backgroundSize =
      face?.style.backgroundSize || faceCs?.backgroundSize || cs.backgroundSize;
    const backgroundPosition =
      face?.style.backgroundPosition ||
      faceCs?.backgroundPosition ||
      cs.backgroundPosition;

    let text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length > 160) text = `${text.slice(0, 157)}…`;

    elements.push({
      name: el.dataset.jsonuiName ?? "",
      path: jsonUiPath(el),
      type: el.dataset.uiType ?? el.dataset.uiName ?? "",
      rect: {
        x: Math.round(r.x * 10) / 10,
        y: Math.round(r.y * 10) / 10,
        w: Math.round(r.width * 10) / 10,
        h: Math.round(r.height * 10) / 10,
      },
      opacity,
      visibility: cs.visibility,
      display: cs.display,
      zIndex: cs.zIndex,
      backgroundImage: shortenBg(backgroundImage),
      backgroundColor,
      backgroundSize,
      backgroundPosition,
      text,
    });
  }

  elements.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
  return { tick, viewport, phud: phudObj, elements };
}

/**
 * @param el - JSON UI node.
 * @returns ancestor `data-jsonui-name` chain joined with `/`.
 */
function jsonUiPath(el: HTMLElement): string {
  const parts: string[] = [];
  let cur: HTMLElement | null = el;
  while (cur && !cur.classList.contains("jsonui-hud-host")) {
    const n = cur.dataset?.jsonuiName;
    if (n) parts.push(n);
    cur = cur.parentElement;
  }
  return parts.reverse().join("/");
}

/**
 * @param bg - CSS background-image value.
 * @returns shorter form for the dump (strip data URLs / keep path).
 */
function shortenBg(bg: string): string {
  if (!bg || bg === "none") return "none";
  const m = /url\(["']?([^"')]+)["']?\)/.exec(bg);
  if (!m) return bg.slice(0, 120);
  const u = m[1]!;
  if (u.startsWith("data:")) return "url(data:…)";
  try {
    const path = new URL(u, location.origin).pathname;
    return `url(${path})`;
  } catch {
    return u.slice(0, 160);
  }
}
