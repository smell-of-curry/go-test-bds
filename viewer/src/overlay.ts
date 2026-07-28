import type { WorldState } from "./store";
import type { CameraMode } from "./camera";
import type { UI } from "./protocol";

/**
 * DOM diagnostic HUD + burnt-in caption band + open-UI panel.
 * Read-only projection of store + camera mode.
 */
export class Overlay {
  private readonly el: HTMLElement;
  private readonly errorEl: HTMLElement;
  private readonly captionEl: HTMLElement;
  private readonly uiEl: HTMLElement;

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

    this.renderCaption(state);
    this.renderUi(state.ui);
  }

  /**
   * Bottom caption: suite / test / elapsed, plus assertion text on failure.
   * Sized for a 1280×720 capture — the diagnostic block above stays small.
   *
   * @param state - World model carrying the latest `mark`.
   */
  private renderCaption(state: WorldState): void {
    const mark = state.mark;
    if (!mark || (!mark.suite && !mark.test && !mark.phase)) {
      this.captionEl.classList.remove("visible");
      this.captionEl.textContent = "";
      return;
    }

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

    this.captionEl.classList.add("visible");
    this.captionEl.classList.toggle("failed", failed);
    this.captionEl.replaceChildren();
    const line = document.createElement("div");
    line.className = "caption-line";
    line.textContent = parts.join("  ·  ");
    this.captionEl.appendChild(line);
    if (message) {
      const msg = document.createElement("div");
      msg.className = "caption-message";
      msg.textContent = message;
      this.captionEl.appendChild(msg);
    }
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

  /** Latest caption text (tests). */
  get captionText(): string {
    return this.captionEl.textContent ?? "";
  }
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
  if (title) {
    const t = document.createElement("div");
    t.className = "ui-title";
    t.textContent = title;
    root.appendChild(t);
  }
  if (body) {
    const b = document.createElement("div");
    b.className = "ui-body";
    b.textContent = body;
    root.appendChild(b);
  }
  if (buttons.length) {
    const list = document.createElement("div");
    list.className = "ui-buttons";
    for (const label of buttons) {
      const btn = document.createElement("div");
      btn.className = "ui-button";
      btn.textContent = label;
      list.appendChild(btn);
    }
    root.appendChild(list);
  }
  return root;
}
