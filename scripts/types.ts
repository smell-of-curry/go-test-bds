export type Vec3 = [number, number, number];
export type Pos = { x: number; y: number; z: number };
export type Rotation = { yaw: number; pitch: number };
export type Face = 0 | 1 | 2 | 3 | 4 | 5;
export type MovementInput = {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sneak: boolean;
};

/**
 * Payloads returned by the observation instructions.
 *
 * These mirror the Go structs the bot marshals into a status message's `data`
 * field. They are hand-written rather than generated because they are a
 * contract between the two sides: changing one without the other is a bug, and
 * a compile error here is the cheapest place to notice.
 */

/** Result of the `getState` instruction. */
export interface BotState {
  name: string;
  xuid: string;
  runtimeId: number;
  position: Pos;
  rotation: Rotation;
  health: number;
  maxHealth: number;
  onGround: boolean;
  gameMode: string;
  dimension: string;
  heldSlot: number;
}

/** One inventory slot, as the bot sees it. */
export interface BotItemStack {
  slot: number;
  /** Item identifier, e.g. `minecraft:stone` or `pokeb:orb_of_frozen_souls`. */
  name: string;
  count: number;
  customName?: string;
}

/** Result of the `getInventory` instruction. */
export interface BotInventory {
  heldSlot: number;
  items: BotItemStack[];
  offhand?: BotItemStack;
  armour?: {
    helmet?: BotItemStack;
    chestplate?: BotItemStack;
    leggings?: BotItemStack;
    boots?: BotItemStack;
  };
}

/** A button on a menu or modal form. */
export interface FormButtonContent {
  text: string;
  image?: string;
}

/** One element of a custom form. */
export interface FormElementContent {
  type: string;
  text?: string;
  options?: string[];
  [key: string]: unknown;
}

/**
 * Result of the `getForm` and `waitForForm` instructions: the form the bot
 * currently has open, or `null` when it has none.
 */
export interface OpenForm {
  type: "menu" | "modal" | "custom";
  title: string;
  /** Present for menu forms. */
  buttons?: FormButtonContent[];
  /** Present for modal forms. */
  button1?: FormButtonContent;
  /** Present for modal forms. */
  button2?: FormButtonContent;
  /** Present for custom forms. */
  content?: FormElementContent[];
}

/** Result of the `getBlock` instruction. */
export interface BlockAtPosition {
  name: string;
  properties: { [key: string]: unknown };
}

/** One entity the bot can see. */
export interface NearbyEntity {
  runtimeId: number;
  type: string;
  name?: string;
  position: Pos;
  distance: number;
}

/** Result of the `getNearbyEntities` instruction. */
export interface NearbyEntities {
  entities: NearbyEntity[];
}

/** A message the bot received. */
export interface ReceivedMessage {
  text: string;
  receivedAtMs: number;
}

/** Result of the `getMessages` instruction. */
export interface ReceivedMessages {
  messages: ReceivedMessage[];
}

/** Result of the `clickFormButton` instruction. */
export interface ClickedFormButton {
  index: number;
  text: string;
}
