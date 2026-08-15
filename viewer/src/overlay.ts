import type { WorldState } from "./store";
import type { CameraMode } from "./camera";
import type { UI } from "./protocol";
import { formatCodesToFragment } from "./ui/formatCodes";

/**
 * DOM diagnostic HUD + open-UI panel.
 * Read-only projection of store + camera mode.
 *
 * The bottom caption band was removed: the top-left `mark` row already carries
 * suite/test/status. Mark frames still flow through the store for the capture
 * harness / timelapse; only the redundant burnt-in strip is gone.
 */
export class Overlay {
  private readonly el: HTMLElement;
  private readonly errorEl: HTMLElement;
  private readonly captionEl: HTMLElement;
  private readonly uiEl: HTMLElement;
  private lastCaptionText = "";

  constructor(
    el: HTMLElement,
    errorEl: HTMLElement,
    captionEl: HTMLElement,
    uiEl: HTMLElement,
  ) {
    this.el = el;
    this.errorEl = errorEl;
    this.captionEl = captionEl;
    this.uiEl = uiEl;
    // Ensure a leftover visible class from an older build cannot stick.
    this.captionEl.classList.remove("visible", "failed");
    this.captionEl.replaceChildren();
  }

  /**
   * @param state - Current world model.
   * @param mode - Active camera mode.
   * @param extras - Scene-side counters the store does not own.
   */
  render(
    state: WorldState,
    mode: CameraMode,
    extras: {
      blockInstanceCount: number;
      sectionMeshCount: number;
      streamError?: string;
    },
  ): void {
    // Only banner a real schema refusal — initial schemaOk:false (awaiting
    // hello/keyframe) is not an error state.
    if (state.schemaError) {
      this.errorEl.textContent = state.schemaError;
      this.errorEl.classList.add("visible");
    } else {
      this.errorEl.classList.remove("visible");
      this.errorEl.textContent = "";
    }

    const actor = state.actor;
    const world = state.world;
    const looking = actor?.lookingAt;
    const lookingStr = looking
      ? `${looking.block.name || `(rid ${looking.block.rid})`} @ ${looking.pos.join(",")}`
      : "—";

    const mark = state.mark;
    const markStr = mark
      ? `${mark.phase}${mark.suite ? ` ${mark.suite}` : ""}${mark.test ? ` / ${mark.test}` : ""}${mark.status ? ` [${mark.status}]` : ""}`
      : "—";

    const lines = [
      `bot       ${state.bot || "—"}`,
      `pos       ${actor ? actor.pos.map((n) => n.toFixed(2)).join(" ") : "—"}`,
      `dim       ${world ? `${world.dimension} (${world.dimensionName})` : "—"}`,
      `tick      ${state.tick}`,
      `columns   ${state.columns.size}`,
      `entities  ${state.entities.size}`,
      `blocks    ${extras.blockInstanceCount}  sections ${extras.sectionMeshCount}`,
      `dropped   ${state.droppedCount}  resync ${state.resyncCount}`,
      `look      ${lookingStr}`,
      `mark      ${markStr}`,
      `camera    ${mode}  (press C to cycle)`,
    ];
    if (extras.streamError) lines.push(`stream    ${extras.streamError}`);
    this.el.textContent = lines.join("\n");

    // Keep captionText for tests / debug; never paint the bottom band.
    this.lastCaptionText = formatCaptionText(state);
    this.captionEl.classList.remove("visible", "failed");
    this.captionEl.replaceChildren();

    this.renderUi(state.ui);
  }

  /**
   * Corner panel for open form / container / dialogue (cheap Stage 11 half).
   *
   * @param ui - Snapshot UI object, or null when nothing is open.
   */
  private renderUi(ui: UI | null): void {
    if (!ui) {
      this.uiEl.classList.remove("visible");
      this.uiEl.replaceChildren();
      return;
    }

    const chunks: HTMLElement[] = [];
    if (ui.form) {
      chunks.push(
        panelBlock("Form", ui.form.title, ui.form.content, ui.form.buttons),
      );
    }
    if (ui.container) {
      const filled = ui.container.slots.filter((s) => s != null).length;
      chunks.push(
        panelBlock(
          "Container",
          ui.container.title || ui.container.type,
          `${ui.container.slots.length} slots (${filled} filled)`,
          [],
        ),
      );
    }
    if (ui.dialogue) {
      chunks.push(
        panelBlock(
          "Dialogue",
          ui.dialogue.npcName,
          ui.dialogue.text,
          ui.dialogue.buttons,
        ),
      );
    }
    if (ui.sign) {
      chunks.push(panelBlock("Sign", "front", ui.sign.front.join("\n"), []));
    }
    // Chat / title / hotbar live in `#player-hud` (Stage 11), not this panel.

    if (!chunks.length) {
      this.uiEl.classList.remove("visible");
      this.uiEl.replaceChildren();
      return;
    }

    this.uiEl.classList.add("visible");
    this.uiEl.replaceChildren(...chunks);
  }

  /**
   * Latest mark caption text (tests). No longer painted on screen — the
   * top-left diagnostic `mark` row is the visible source of truth.
   */
  get captionText(): string {
    return this.lastCaptionText;
  }
}

/**
 * Build the legacy caption string from the active mark (for `__viewer.captionText`).
 *
 * @param state - World model carrying the latest `mark`.
 * @returns caption text, or "" when no mark is active.
 */
function formatCaptionText(state: WorldState): string {
  const mark = state.mark;
  if (!mark || (!mark.suite && !mark.test && !mark.phase)) return "";

  const suite = mark.suite ?? "";
  const test = mark.test ?? mark.phase;
  const elapsed =
    typeof mark.elapsedMs === "number" ? formatElapsed(mark.elapsedMs) : "";
  const head = [suite, test].filter(Boolean).join(" · ");
  const status = mark.status ? mark.status.toUpperCase() : "";
  const failed = mark.status === "failed";
  const message =
    failed && mark.message && mark.message.length > 0 ? mark.message : "";

  const parts = [head];
  if (elapsed) parts.push(elapsed);
  if (status) parts.push(status);
  const line = parts.join("  ·  ");
  return message ? `${line}${message}` : line;
}

/**
 * @param ms - Elapsed milliseconds from the mark frame.
 * @returns compact human duration for the caption band.
 */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * @param kind - Panel kind label.
 * @param title - Title line.
 * @param body - Optional body text.
 * @param buttons - Button labels.
 * @returns a filled panel element.
 */
function panelBlock(
  kind: string,
  title: string,
  body: string,
  buttons: string[],
): HTMLElement {
  const root = document.createElement("div");
  root.className = "ui-block";
  const kindEl = document.createElement("div");
  kindEl.className = "ui-kind";
  kindEl.textContent = kind;
  root.appendChild(kindEl);
  // formatCodesToFragment, not textContent: form text carries § formatting
  // codes ("§lBulbasaur§r §7No. 001") that should color like a real client.
  if (title) {
    const t = document.createElement("div");
    t.className = "ui-title";
    t.appendChild(formatCodesToFragment(title));
    root.appendChild(t);
  }
  if (body) {
    const b = document.createElement("div");
    b.className = "ui-body";
    b.appendChild(formatCodesToFragment(body));
    root.appendChild(b);
  }
  if (buttons.length) {
    const list = document.createElement("div");
    list.className = "ui-buttons";
    for (const label of buttons) {
      const btn = document.createElement("div");
      btn.className = "ui-button";
      btn.appendChild(formatCodesToFragment(label));
      list.appendChild(btn);
    }
    root.appendChild(list);
  }
  return root;
}
