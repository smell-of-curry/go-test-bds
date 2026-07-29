import type { Item } from "../protocol";

/** Armour slot index: 0 helmet … 3 boots (matches snapshot `armour[]`). */
export type ArmourSlot = 0 | 1 | 2 | 3;

/** Resolved pack assets for one armour piece. */
export interface ArmourLayerSpec {
  slot: ArmourSlot;
  /** `geometry.humanoid.armor.*` identifier. */
  geometryId: string;
  /** Pack-relative texture path (no extension). */
  texturePath: string;
}

/** Held-item attach target. */
export interface HeldItemSpec {
  item: Item;
  /** Preferred bone names, first match wins. */
  boneCandidates: string[];
}

const SLOT_GEO: Record<ArmourSlot, string> = {
  0: "geometry.humanoid.armor.helmet",
  1: "geometry.humanoid.armor.chestplate",
  2: "geometry.humanoid.armor.leggings",
  3: "geometry.humanoid.armor.boots",
};

/** Layer-1 (helmet/chest/boots) vs layer-2 (leggings) texture suffix. */
const SLOT_LAYER: Record<ArmourSlot, 1 | 2> = {
  0: 1,
  1: 1,
  2: 2,
  3: 1,
};

/**
 * Map an armour item id to the vanilla layer texture stem
 * (`textures/models/armor/<stem>_1` / `_2`).
 *
 * @param itemName - Namespaced item id.
 * @returns stem or null when not recognisable armour.
 */
export function armourTextureStem(itemName: string): string | null {
  const n = itemName.toLowerCase().replace(/^minecraft:/, "");
  // ponytail: substring table only — custom/addon armour needs attachables.
  if (n.includes("netherite")) return "netherite";
  if (n.includes("diamond")) return "diamond";
  if (n.includes("golden") || n.includes("gold")) return "gold";
  if (n.includes("iron")) return "iron";
  if (n.includes("chainmail") || n.includes("chain")) return "chain";
  if (n.includes("leather")) return "leather";
  if (n.includes("turtle")) return "turtle";
  if (n.includes("copper")) return "copper";
  return null;
}

/**
 * Whether an item name looks like wearable armour for the given slot.
 *
 * @param itemName - Item id.
 * @param slot - Armour slot.
 * @returns true when the name matches common slot suffixes.
 */
export function looksLikeArmour(itemName: string, slot: ArmourSlot): boolean {
  const n = itemName.toLowerCase();
  switch (slot) {
    case 0:
      return n.includes("helmet") || n.includes("turtle_shell");
    case 1:
      return n.includes("chestplate") || n.includes("elytra");
    case 2:
      return n.includes("leggings");
    case 3:
      return n.includes("boots");
    default:
      return false;
  }
}

/**
 * Select armour layer geometry + texture for snapshot slots.
 *
 * @param armour - Four snapshot slots (helmet→boots).
 * @returns specs for pieces that resolve.
 */
export function selectArmourLayers(
  armour: Array<Item | null | undefined> | undefined,
): ArmourLayerSpec[] {
  if (!armour) return [];
  const out: ArmourLayerSpec[] = [];
  for (let i = 0; i < 4; i++) {
    const slot = i as ArmourSlot;
    const item = armour[slot];
    if (!item?.name) continue;
    if (!looksLikeArmour(item.name, slot) && !armourTextureStem(item.name)) {
      continue;
    }
    const stem = armourTextureStem(item.name);
    if (!stem) continue;
    const layer = SLOT_LAYER[slot];
    out.push({
      slot,
      geometryId: SLOT_GEO[slot],
      texturePath: `textures/models/armor/${stem}_${layer}`,
    });
  }
  return out;
}

const HELD_BONES = [
  "rightitem",
  "RightItem",
  "right_item",
  "rightHandItem",
  "rightHand",
  "RightHand",
  "rightArm",
  "RightArm",
  "rightarm",
];

/**
 * @param held - Snapshot held items.
 * @returns main-hand spec or null.
 */
export function selectHeldItem(
  held:
    | {
        main?: Item | null;
        off?: Item | null;
      }
    | null
    | undefined,
): HeldItemSpec | null {
  const item = held?.main;
  if (!item?.name) return null;
  return { item, boneCandidates: HELD_BONES };
}

/**
 * Pick the first bone present in `bones`.
 *
 * @param bones - Model bone map.
 * @param candidates - Preferred names.
 * @returns bone name or null.
 */
export function pickBone(
  bones: Map<string, unknown>,
  candidates: string[],
): string | null {
  for (const c of candidates) {
    if (bones.has(c)) return c;
  }
  // Case-insensitive fallback.
  const lower = new Map<string, string>();
  for (const k of bones.keys()) lower.set(k.toLowerCase(), k);
  for (const c of candidates) {
    const hit = lower.get(c.toLowerCase());
    if (hit) return hit;
  }
  return null;
}
