import type { WorldState } from "./store";
import type { CameraMode } from "./camera";

/**
 * DOM diagnostic HUD. Read-only projection of store + camera mode.
 */
export class Overlay {
  private readonly el: HTMLElement;
  private readonly errorEl: HTMLElement;

  constructor(el: HTMLElement, errorEl: HTMLElement) {
    this.el = el;
    this.errorEl = errorEl;
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
    if (!state.schemaOk) {
      this.errorEl.textContent = state.schemaError ?? "unsupported schema";
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
      `camera    ${mode}  (press C to toggle)`,
    ];
    if (extras.streamError) lines.push(`stream    ${extras.streamError}`);
    this.el.textContent = lines.join("\n");
  }
}
