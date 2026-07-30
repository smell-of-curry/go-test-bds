/**
 * Viewer-only waypoint locator strip driven by `state.waypoint`.
 * Not pack JSON UI — Bedrock has no ui/*.json for this overlay.
 */

import type { WorldState } from "../store";
import { parseWaypoint, relativeBearing, waypointDistance } from "./phud/parse";
import "./waypointStrip.css";

/** Handle wired into the store subscriber (same shape as other overlays). */
export interface WaypointStripHandle {
  /** Project store state onto the strip. */
  onFrame(state: WorldState): void;
  /** Root element (tests). */
  readonly root: HTMLElement;
}

/**
 * Mount the waypoint locator strip under `document.body`.
 *
 * @returns handle for the store loop.
 */
export function initWaypointStrip(): WaypointStripHandle {
  const root = document.createElement("div");
  root.id = "waypoint-strip";
  root.innerHTML = `<div class="jh-waypoint" data-jh="waypoint" hidden></div>`;
  document.body.appendChild(root);

  const waypointEl = root.querySelector('[data-jh="waypoint"]') as HTMLElement;
  let waypointKey: string | null = null;

  /**
   * @param state - Latest world state.
   */
  function renderWaypoint(state: WorldState): void {
    const mark = state.waypoint;
    const actor = state.actor;
    const target = mark ? parseWaypoint(mark.message ?? "") : null;
    if (!target || !actor) {
      if (waypointKey !== "") {
        waypointKey = "";
        waypointEl.hidden = true;
        waypointEl.replaceChildren();
      }
      return;
    }
    const yaw = actor.rot[0];
    const rel = relativeBearing(actor.pos, yaw, target);
    const dist = waypointDistance(actor.pos, target);
    const key = `${mark!.message}\0${Math.round(rel)}\0${dist}`;
    if (key === waypointKey) return;
    waypointKey = key;

    waypointEl.hidden = false;
    waypointEl.replaceChildren();
    const track = document.createElement("div");
    track.className = "jh-waypoint-track";
    const dot = document.createElement("div");
    dot.className = "jh-waypoint-dot";
    // Slide the dot along the strip like the Bedrock locator bar: dead ahead
    // = centre, ±90° pins to the edge.
    const t = Math.min(1, Math.max(-1, rel / 90));
    dot.style.left = `${50 + t * 50}%`;
    track.appendChild(dot);
    const arrow = document.createElement("div");
    arrow.className = "jh-waypoint-arrow";
    arrow.style.transform = `rotate(${Math.round(rel)}deg)`;
    const text = document.createElement("div");
    text.className = "jh-waypoint-text";
    text.textContent = `${dist}m${target.label ? ` \u00b7 ${target.label}` : ""}`;
    waypointEl.append(track, arrow, text);
  }

  return {
    root,
    onFrame(state: WorldState): void {
      renderWaypoint(state);
    },
  };
}
