import type { ParticleRegistry, ParticleSystem } from "../particles";
import type { Actor, Item, UI } from "../protocol";
import type { WorldState } from "../store";
import { BlockBreakEffects } from "./effects";
import { formatCodesToFragment, stripFormatCodes } from "./formatCodes";
import "./hud.css";

const CHAT_LIMIT = 8;
const CHAT_FADE_MS = 10_000;
const TICK_MS = 50; // 20 TPS
const DEFAULT_FADE_IN = 10;
const DEFAULT_STAY = 70;
const DEFAULT_FADE_OUT = 20;

interface ChatLine {
  el: HTMLElement;
  bornMs: number;
  text: string;
}

interface TimedText {
  text: string;
  bornMs: number;
  fadeInMs: number;
  stayMs: number;
  fadeOutMs: number;
}

export interface HudHandle {
  /** Project store state onto the HUD (call before clearDirty). */
  onFrame(state: WorldState): void;
  /** Advance fades / particles. */
  tick(nowMs: number): void;
  /** Test helper — chat line count in the DOM. */
  readonly chatCount: number;
  /** Test helper — active break-burst count. */
  readonly burstCount: number;
}

/**
 * Init the player-facing HUD overlay + block-break particle bursts.
 *
 * Self-contained: creates its own root under `document.body`.
 *
 * @param opts.particles - Shared Stage 11 particle runtime.
 * @param opts.particleRegistry - Optional pack registry for vanilla break FX.
 * @returns handle wired into the paint / store loops.
 */
export function initHud(opts: {
  particles: ParticleSystem;
  getParticleRegistry?: () => ParticleRegistry | null;
}): HudHandle {
  const root = document.createElement("div");
  root.id = "player-hud";
  root.innerHTML = `
    <div class="hud-chat" data-hud="chat"></div>
    <div class="hud-title-wrap">
      <div class="hud-title" data-hud="title"></div>
      <div class="hud-subtitle" data-hud="subtitle"></div>
    </div>
    <div class="hud-actionbar" data-hud="actionbar"></div>
    <div class="hud-hotbar-wrap">
      <div class="hud-vitals">
        <div class="hud-hearts" data-hud="hearts"></div>
        <div class="hud-food" data-hud="food"></div>
      </div>
      <div class="hud-hotbar" data-hud="hotbar"></div>
    </div>
  `;
  document.body.appendChild(root);

  const chatEl = root.querySelector('[data-hud="chat"]') as HTMLElement;
  const titleEl = root.querySelector('[data-hud="title"]') as HTMLElement;
  const subtitleEl = root.querySelector('[data-hud="subtitle"]') as HTMLElement;
  const actionEl = root.querySelector('[data-hud="actionbar"]') as HTMLElement;
  const heartsEl = root.querySelector('[data-hud="hearts"]') as HTMLElement;
  const foodEl = root.querySelector('[data-hud="food"]') as HTMLElement;
  const hotbarEl = root.querySelector('[data-hud="hotbar"]') as HTMLElement;

  const chat: ChatLine[] = [];
  let titleState: TimedText | null = null;
  let subtitleState: TimedText | null = null;
  let actionState: TimedText | null = null;
  let lastTitleKey = "";
  let lastActionKey = "";
  let lastHotbarKey = "";
  let lastVitalsKey = "";
  let lastMessagesKey = "";

  const effects = new BlockBreakEffects(
    opts.particles,
    opts.getParticleRegistry ?? (() => null),
  );

  function pushChat(text: string, nowMs: number): void {
    if (!text) return;
    const el = document.createElement("div");
    el.className = "hud-chat-line";
    el.appendChild(formatCodesToFragment(text));
    chatEl.appendChild(el);
    chat.push({ el, bornMs: nowMs, text });
    while (chat.length > CHAT_LIMIT) {
      const old = chat.shift();
      old?.el.remove();
    }
  }

  function applyMessages(messages: string[] | undefined, nowMs: number): void {
    if (!messages) return;
    const key = JSON.stringify(messages);
    if (key === lastMessagesKey) return;
    const prev = new Set(
      lastMessagesKey ? (JSON.parse(lastMessagesKey) as string[]) : [],
    );
    lastMessagesKey = key;
    for (const m of messages) {
      if (!prev.has(m)) pushChat(m, nowMs);
    }
  }

  function applyUi(ui: UI | null, nowMs: number): void {
    if (!ui) return;
    applyMessages(ui.messages, nowMs);
    const fadeIn = ticksToMs(ui.fadeInTicks ?? DEFAULT_FADE_IN);
    const stay = ticksToMs(ui.stayTicks ?? DEFAULT_STAY);
    const fadeOut = ticksToMs(ui.fadeOutTicks ?? DEFAULT_FADE_OUT);
    const titleKey = `${ui.title ?? ""}\0${ui.subtitle ?? ""}\0${fadeIn}\0${stay}\0${fadeOut}`;
    if (titleKey !== lastTitleKey) {
      lastTitleKey = titleKey;
      if (ui.title) {
        titleState = {
          text: ui.title,
          bornMs: nowMs,
          fadeInMs: fadeIn,
          stayMs: stay,
          fadeOutMs: fadeOut,
        };
      } else {
        titleState = null;
      }
      if (ui.subtitle) {
        subtitleState = {
          text: ui.subtitle,
          bornMs: nowMs,
          fadeInMs: fadeIn,
          stayMs: stay,
          fadeOutMs: fadeOut,
        };
      } else {
        subtitleState = null;
      }
    }
    const actionKey = `${ui.actionBar ?? ""}\0${fadeIn}\0${stay}\0${fadeOut}`;
    if (actionKey !== lastActionKey) {
      lastActionKey = actionKey;
      if (ui.actionBar) {
        actionState = {
          text: ui.actionBar,
          bornMs: nowMs,
          fadeInMs: fadeIn,
          stayMs: stay,
          fadeOutMs: fadeOut,
        };
      } else {
        actionState = null;
      }
    }
  }

  function renderTimed(
    el: HTMLElement,
    state: TimedText | null,
    nowMs: number,
  ): void {
    if (!state) {
      el.replaceChildren();
      el.style.opacity = "0";
      return;
    }
    const opacity = timedOpacity(state, nowMs);
    if (opacity <= 0) {
      el.replaceChildren();
      el.style.opacity = "0";
      return;
    }
    if (el.dataset.text !== state.text) {
      el.dataset.text = state.text;
      el.replaceChildren(formatCodesToFragment(state.text));
    }
    el.style.opacity = String(opacity);
  }

  function renderVitals(actor: Actor | null): void {
    const key = actor ? `${actor.health}/${actor.maxHealth}/${actor.food}` : "";
    if (key === lastVitalsKey) return;
    lastVitalsKey = key;
    if (!actor || !(actor.maxHealth > 0)) {
      heartsEl.textContent = "";
      foodEl.textContent = "";
      return;
    }
    const hearts = Math.max(0, Math.ceil(actor.health / 2));
    const maxHearts = Math.max(1, Math.ceil(actor.maxHealth / 2));
    heartsEl.textContent = `HP ${hearts}/${maxHearts}`;
    if (actor.food > 0) {
      foodEl.textContent = `Food ${Math.ceil(actor.food / 2)}`;
    } else {
      foodEl.textContent = "";
    }
  }

  function renderHotbar(actor: Actor | null): void {
    if (!actor) {
      if (lastHotbarKey !== "") {
        lastHotbarKey = "";
        hotbarEl.replaceChildren();
      }
      return;
    }
    const slots = actor.hotbar ?? [];
    const key = `${actor.heldSlot}|${slots.map(slotKey).join("|")}`;
    if (key === lastHotbarKey) return;
    lastHotbarKey = key;
    hotbarEl.replaceChildren();
    for (let i = 0; i < 9; i++) {
      const slot = document.createElement("div");
      slot.className = "hud-slot" + (i === actor.heldSlot ? " selected" : "");
      const item = slots[i] ?? null;
      if (item) {
        const name = document.createElement("div");
        name.className = "hud-slot-name";
        name.textContent = shortItemName(item);
        slot.appendChild(name);
        if (item.count > 1) {
          const count = document.createElement("div");
          count.className = "hud-slot-count";
          count.textContent = String(item.count);
          slot.appendChild(count);
        }
      }
      hotbarEl.appendChild(slot);
    }
  }

  return {
    onFrame(state: WorldState): void {
      const now = performance.now();
      applyUi(state.ui, now);
      renderVitals(state.actor);
      renderHotbar(state.actor);
      if (state.dirtyBlocks.length) {
        effects.spawn(state.dirtyBlocks);
      }
    },
    tick(nowMs: number): void {
      for (const line of chat) {
        line.el.classList.toggle("faded", nowMs - line.bornMs >= CHAT_FADE_MS);
      }
      renderTimed(titleEl, titleState, nowMs);
      renderTimed(subtitleEl, subtitleState, nowMs);
      renderTimed(actionEl, actionState, nowMs);
      effects.tick(nowMs);
    },
    get chatCount() {
      return chat.length;
    },
    get burstCount() {
      return effects.count;
    },
  };
}

/**
 * @param ticks - Duration in Bedrock ticks (20ths of a second).
 * @returns milliseconds.
 */
function ticksToMs(ticks: number): number {
  return Math.max(0, ticks) * TICK_MS;
}

/**
 * @param state - Timed title/actionbar state.
 * @param nowMs - Now.
 * @returns opacity 0–1 through fade-in / stay / fade-out.
 */
function timedOpacity(state: TimedText, nowMs: number): number {
  const age = nowMs - state.bornMs;
  if (age < state.fadeInMs) {
    return state.fadeInMs <= 0 ? 1 : age / state.fadeInMs;
  }
  if (age < state.fadeInMs + state.stayMs) return 1;
  const outAge = age - state.fadeInMs - state.stayMs;
  if (outAge >= state.fadeOutMs) return 0;
  return state.fadeOutMs <= 0 ? 0 : 1 - outAge / state.fadeOutMs;
}

/**
 * @param item - Stack or null.
 * @returns stable key for hotbar dirty-check.
 */
function slotKey(item: Item | null | undefined): string {
  if (!item) return "";
  return `${item.name}x${item.count}`;
}

/**
 * @param item - Inventory stack.
 * @returns short display name (no namespace, spaces for underscores).
 */
function shortItemName(item: Item): string {
  const raw = item.customName
    ? stripFormatCodes(item.customName)
    : item.name.includes(":")
      ? item.name.slice(item.name.indexOf(":") + 1)
      : item.name;
  return raw.replace(/_/g, " ");
}
