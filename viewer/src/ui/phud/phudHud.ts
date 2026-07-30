/**
 * JSON-UI-faithful PokeBedrock HUD overlay.
 *
 * DOM/CSS projection of the raw `phud` token lane plus the open server form,
 * laid out to match the pack's ui/*.json (sidebar, ping, currency banner,
 * battle bar, battle log, centered vanilla form) with textures fetched over
 * the hub's /asset route. Every texture has a flat-colour fallback so a
 * fixture stream with no pack renders deterministically (Playwright goldens).
 */
import type { UI } from "../../protocol";
import type { WorldState } from "../../store";
import { createFormRenderer, type FormRenderer } from "../jsonui/forms";
import type { PropertyBag, UiResolver } from "../jsonui/types";
import {
  isBattleForm,
  parseBattleForm,
  parseCurrency,
  parseSidebar,
  parseWaypoint,
  relativeBearing,
  waypointDistance,
  type BattleForm,
} from "./parse";
import { richTextFragment } from "./richText";
import "./phud.css";

export interface PhudHandle {
  /** Project store state onto the HUD (call from the store subscriber). */
  onFrame(state: WorldState): void;
  /** Root element (tests). */
  readonly root: HTMLElement;
}

/** Optional JSON UI engine deps for server-form rendering. */
export interface PhudFormEngine {
  resolver: UiResolver;
  globals?: PropertyBag;
}

/**
 * Install the PokeBedrock HUD overlay under `document.body`.
 *
 * @param opts.assetBaseUrl - Origin serving `/asset/…` ("" = no textures,
 * CSS fallbacks only).
 * @param opts.formEngine - When set, server forms render via the JSON UI
 * engine (`createFormRenderer`); otherwise the legacy CSS battle/form panels.
 * @returns handle wired into the store loop.
 */
export function initPhudHud(opts: {
  assetBaseUrl?: string;
  formEngine?: PhudFormEngine;
}): PhudHandle {
  const assetBase = (opts.assetBaseUrl ?? "").replace(/\/$/, "");
  const root = document.createElement("div");
  root.id = "json-hud";
  root.innerHTML = `
    <div class="jh-ping" data-jh="ping" hidden></div>
    <div class="jh-topbar" data-jh="topbar" hidden>
      <div class="jh-banner" data-jh="banner"></div>
      <div class="jh-currency" data-jh="currency"></div>
    </div>
    <div class="jh-waypoint" data-jh="waypoint" hidden></div>
    <div class="jh-sidebar" data-jh="sidebar" hidden></div>
    <div class="jh-battlelog" data-jh="battlelog" hidden>
      <div class="jh-battlelog-inner" data-jh="battlelog-lines"></div>
    </div>
    <div class="jh-battlebar" data-jh="battlebar" hidden></div>
    <div class="jh-form" data-jh="form" hidden></div>
    <div class="jh-form-engine" data-jh="form-engine" hidden></div>
  `;
  document.body.appendChild(root);

  const el = (name: string): HTMLElement =>
    root.querySelector(`[data-jh="${name}"]`) as HTMLElement;
  const pingEl = el("ping");
  const topbarEl = el("topbar");
  const bannerEl = el("banner");
  const currencyEl = el("currency");
  const waypointEl = el("waypoint");
  const sidebarEl = el("sidebar");
  const battlelogEl = el("battlelog");
  const battlelogLinesEl = el("battlelog-lines");
  const battlebarEl = el("battlebar");
  const formEl = el("form");
  const formEngineEl = el("form-engine");

  const formRenderer: FormRenderer | null = opts.formEngine
    ? createFormRenderer({
        resolver: opts.formEngine.resolver,
        globals: opts.formEngine.globals,
        host: formEngineEl,
        assets: {
          textureUrl(path: string): string {
            if (!assetBase) return "";
            const withExt = /\.[a-z]{3,4}$/i.test(path) ? path : `${path}.png`;
            return `${assetBase}/asset/${withExt}`;
          },
        },
      })
    : null;

  let pingKey: string | null = null;
  let currencyKey: string | null = null;
  let sidebarKey: string | null = null;
  let battleLogKey: string | null = null;
  let formRenderKey: string | null = null;
  let waypointKey: string | null = null;

  /**
   * Resolve a pack texture reference to an /asset URL.
   *
   * @param path - Pack path without extension (`textures/ui/sidebar/dock`).
   * @returns CSS url() value, or "" when no asset base is configured.
   */
  function assetUrl(path: string): string {
    if (!assetBase) return "";
    const withExt = /\.[a-z]{3,4}$/i.test(path) ? path : `${path}.png`;
    return `url("${assetBase}/asset/${withExt}")`;
  }

  /**
   * Layer a texture over a flat-colour fallback: when the URL 404s the
   * browser paints nothing for that layer and the fallback beneath shows.
   *
   * @param target - Element to paint.
   * @param path - Pack texture path.
   * @param fallback - CSS image (gradient) painted beneath, or "".
   */
  function paintTexture(
    target: HTMLElement,
    path: string,
    fallback = "",
  ): void {
    const url = assetUrl(path);
    const layers = [url, fallback].filter(Boolean).join(", ");
    if (layers) target.style.backgroundImage = layers;
  }

  function renderPing(value: string | undefined): void {
    const key = value ?? "";
    if (key === pingKey) return;
    pingKey = key;
    if (!key) {
      pingEl.hidden = true;
      return;
    }
    pingEl.hidden = false;
    pingEl.replaceChildren();
    const label = document.createElement("span");
    label.textContent = "Current Ping:";
    pingEl.appendChild(label);
    pingEl.appendChild(richTextFragment(key, assetBase));
  }

  function renderCurrency(value: string | undefined): void {
    const key = value ?? "";
    if (key === currencyKey) return;
    currencyKey = key;
    if (!key) {
      topbarEl.hidden = true;
      return;
    }
    const { banner, currency } = parseCurrency(key);
    topbarEl.hidden = false;
    bannerEl.hidden = banner === "";
    bannerEl.replaceChildren(richTextFragment(banner, assetBase));
    currencyEl.hidden = currency === "";
    currencyEl.replaceChildren(richTextFragment(currency, assetBase));
  }

  function renderSidebar(value: string | undefined): void {
    const key = value ?? "";
    if (key === sidebarKey) return;
    sidebarKey = key;
    if (!key) {
      sidebarEl.hidden = true;
      sidebarEl.replaceChildren();
      return;
    }
    sidebarEl.hidden = false;
    paintTexture(sidebarEl, "textures/ui/sidebar/dock");
    sidebarEl.replaceChildren();
    for (const slot of parseSidebar(key)) {
      const slotEl = document.createElement("div");
      slotEl.className = "jh-slot" + (slot.selected ? " selected" : "");

      if (!slot.empty) {
        const plate = document.createElement("div");
        plate.className = "jh-plate";
        paintTexture(plate, "textures/ui/sidebar/data");
        const name = document.createElement("div");
        name.className = "jh-slot-name";
        name.appendChild(richTextFragment(slot.name, assetBase));
        const stats = document.createElement("div");
        stats.className = "jh-slot-stats";
        stats.appendChild(richTextFragment(slot.stats, assetBase));
        const xp = document.createElement("div");
        xp.className = "jh-slot-xp";
        const fill = document.createElement("div");
        fill.className = "jh-slot-xp-fill";
        // clip_ratio convention: the wire percent is the HIDDEN fraction.
        fill.style.width = `${100 - slot.xpClipPercent}%`;
        xp.appendChild(fill);
        plate.append(name, stats, xp);
        slotEl.appendChild(plate);
      }

      const ball = document.createElement("div");
      ball.className = "jh-ball jh-ball-fallback";
      paintTexture(ball, `textures/ui/sidebar/balls/${slot.ball}`);
      if (slot.sprite) {
        const sprite = document.createElement("div");
        sprite.className = "jh-ball-sprite";
        paintTexture(sprite, `textures/sprites/${slot.sprite}`);
        ball.appendChild(sprite);
      }
      slotEl.appendChild(ball);
      sidebarEl.appendChild(slotEl);
    }
  }

  function renderBattleLog(value: string | undefined, formOpen: boolean): void {
    // The feeder clears battleWait before opening the action form; if both
    // ever overlap the form bar wins the bottom strip.
    const key = formOpen ? "" : (value ?? "");
    if (key === battleLogKey) return;
    battleLogKey = key;
    if (!key.trim()) {
      battlelogEl.hidden = true;
      battlelogLinesEl.replaceChildren();
      return;
    }
    battlelogEl.hidden = false;
    battlelogLinesEl.replaceChildren();
    for (const line of key.split("\n")) {
      if (!line.trim()) continue;
      const lineEl = document.createElement("div");
      lineEl.className = "jh-battlelog-line";
      lineEl.appendChild(richTextFragment(line, assetBase));
      battlelogLinesEl.appendChild(lineEl);
    }
  }

  function renderBattleBar(
    form: NonNullable<UI["form"]>,
    battle: BattleForm,
    hover: number | null,
  ): void {
    battlebarEl.replaceChildren();

    // Left: bag / pokemon / run tabs (icon textures, colour-coded fallback).
    const tabs = document.createElement("div");
    tabs.className = "jh-battle-tabs";
    const TAB_FALLBACK: Record<string, string> = {
      bag: "linear-gradient(#4d7fd6, #4d7fd6)",
      pokemon: "linear-gradient(#c8c8c8, #c8c8c8)",
      run: "linear-gradient(#e0a531, #e0a531)",
    };
    for (const tab of battle.tabs) {
      const tabEl = document.createElement("div");
      tabEl.className =
        "jh-battle-tab" +
        (tab.disabled ? " disabled" : "") +
        (hover === tab.index ? " hovered" : "");
      tabEl.dataset.kind = tab.kind;
      paintTexture(
        tabEl,
        `textures/ui/battle/menu_${tab.kind === "pokemon" ? "poke" : tab.kind}`,
        TAB_FALLBACK[tab.kind],
      );
      tabs.appendChild(tabEl);
    }
    battlebarEl.appendChild(tabs);

    // Centre: 2-column move grid + the pokeball / mega badge between them.
    const center = document.createElement("div");
    center.className = "jh-battle-center";
    const grid = document.createElement("div");
    grid.className = "jh-battle-moves";
    for (const move of battle.moves) {
      const moveEl = document.createElement("div");
      moveEl.className =
        "jh-move" +
        (move.disabled ? " disabled" : "") +
        (hover === move.index ? " hovered" : "");
      const plate = document.createElement("div");
      plate.className = "jh-move-plate";
      paintTexture(plate, "textures/ui/battle/moveSelection");
      const typeIcon = document.createElement("div");
      // Column 1 puts the type icon on the right (mirrored layout, like the
      // real client); column 0 on the left.
      typeIcon.className =
        "jh-move-type jh-move-type-fallback " +
        (battle.moves.indexOf(move) % 2 === 0 ? "left" : "right");
      paintTexture(typeIcon, `textures/ui/gui/attacks/${move.type}`);
      const name = document.createElement("span");
      name.appendChild(richTextFragment(move.name, assetBase));
      plate.append(typeIcon, name);

      const pp = document.createElement("div");
      pp.className = "jh-move-pp";
      const fill = document.createElement("div");
      fill.className = "jh-move-pp-fill";
      const frac =
        move.ppBar != null
          ? move.ppBar / 20
          : move.maxpp > 0
            ? move.pp / move.maxpp
            : 0;
      fill.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
      const ppText = document.createElement("div");
      ppText.className = "jh-move-pp-text";
      ppText.textContent = `${move.pp}/${move.maxpp}`;
      pp.append(fill, ppText);

      moveEl.append(plate, pp);
      grid.appendChild(moveEl);
    }
    center.appendChild(grid);

    if (battle.ball) {
      const ballEl = document.createElement("div");
      ballEl.className =
        "jh-battle-ball" + (hover === battle.ball.index ? " hovered" : "");
      paintTexture(
        ballEl,
        `textures/ui/battle/moveSelectionBadges/${battle.ball.badge}`,
        "linear-gradient(#e33 48%, #1c1c1c 48%, #1c1c1c 56%, #f4f4f4 56%)",
      );
      center.appendChild(ballEl);
    }
    battlebarEl.appendChild(center);

    // Right: red info panel — turn / timer / weather / terrain from the form
    // body.
    const info = document.createElement("div");
    info.className = "jh-battle-info";
    for (const line of form.content.split("\n")) {
      if (!line.trim()) continue;
      const lineEl = document.createElement("div");
      lineEl.className = "jh-battle-info-line";
      lineEl.appendChild(richTextFragment(line, assetBase));
      info.appendChild(lineEl);
    }
    battlebarEl.appendChild(info);
  }

  /**
   * Resolve a form button icon reference to a texture path or URL.
   *
   * @param icon - Wire image data (pack path or http URL).
   * @returns CSS background-image value, or "".
   */
  function iconImage(icon: string): string {
    if (!icon) return "";
    if (/^https?:\/\//.test(icon)) return `url("${icon}")`;
    return assetUrl(icon);
  }

  function renderFormModal(
    form: NonNullable<UI["form"]>,
    hover: number | null,
  ): void {
    formEl.replaceChildren();

    const title = document.createElement("div");
    title.className = "jh-form-title";
    title.appendChild(richTextFragment(form.title, assetBase));
    const close = document.createElement("span");
    close.className = "jh-form-close";
    close.textContent = "\u00d7";
    title.appendChild(close);
    formEl.appendChild(title);

    const body = document.createElement("div");
    body.className = "jh-form-body";
    if (form.content.trim()) {
      const content = document.createElement("div");
      content.className = "jh-form-content";
      content.appendChild(richTextFragment(form.content, assetBase));
      body.appendChild(content);
    }

    const buttons = form.buttons ?? [];
    if (form.type === "modal") {
      // Modal: two choice buttons side by side under the content.
      const row = document.createElement("div");
      row.className = "jh-form-buttons-row";
      buttons.forEach((label, i) => {
        const btn = document.createElement("div");
        btn.className = "jh-form-button" + (hover === i ? " hovered" : "");
        btn.appendChild(richTextFragment(label, assetBase));
        row.appendChild(btn);
      });
      body.appendChild(row);
    } else {
      buttons.forEach((label, i) => {
        const row = document.createElement("div");
        row.className = "jh-form-row";
        const icon = form.buttonImages?.[i] ?? "";
        if (icon) {
          const iconEl = document.createElement("div");
          iconEl.className = "jh-form-row-icon";
          const img = iconImage(icon);
          if (img) iconEl.style.backgroundImage = img;
          row.appendChild(iconEl);
        }
        const btn = document.createElement("div");
        btn.className = "jh-form-button" + (hover === i ? " hovered" : "");
        btn.appendChild(richTextFragment(label, assetBase));
        row.appendChild(btn);
        body.appendChild(row);
      });
    }
    formEl.appendChild(body);
  }

  function renderForms(ui: UI | null, hover: number | null): void {
    const form = ui?.form ?? null;
    const key = form
      ? `${form.type}\0${form.title}\0${form.content}\0${(form.buttons ?? []).join("\0")}\0${(form.buttonImages ?? []).join("\0")}\0${hover ?? ""}`
      : "";
    if (key === formRenderKey) return;
    formRenderKey = key;

    if (formRenderer) {
      battlebarEl.hidden = true;
      formEl.hidden = true;
      if (!form) {
        formEngineEl.hidden = true;
        formRenderer.hide();
        return;
      }
      formEngineEl.hidden = false;
      formRenderer.show(form);
      formRenderer.hover(hover);
      return;
    }

    formEngineEl.hidden = true;
    if (!form) {
      battlebarEl.hidden = true;
      formEl.hidden = true;
      return;
    }
    if (isBattleForm(form.buttons)) {
      formEl.hidden = true;
      battlebarEl.hidden = false;
      renderBattleBar(
        form,
        parseBattleForm(form.buttons, form.buttonImages),
        hover,
      );
      return;
    }
    battlebarEl.hidden = true;
    formEl.hidden = false;
    renderFormModal(form, hover);
  }

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
      renderPing(state.phud.get("playerPing"));
      renderCurrency(state.phud.get("currency"));
      renderSidebar(state.phud.get("sidebar"));
      renderForms(state.ui, state.formHover);
      renderBattleLog(
        state.phud.get("battleWait"),
        !battlebarEl.hidden || !formEl.hidden || !formEngineEl.hidden,
      );
      renderWaypoint(state);
    },
  };
}
