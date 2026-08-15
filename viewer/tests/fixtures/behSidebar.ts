/**
 * BEH-faithful `&_sidebar:` packing (mirrors pokebedrock-beh `sidebar.ts`).
 *
 * Per occupied slot, 7 fields each `padEnd(120, '|')`, then joined with `|`
 * (stride 121 = `$var_size`). Field order:
 *   0 stats, 1 nickname, 2 species, 3 active, 4 ball type, 5 icon, 6 XP clip %
 *
 * Clip percent is the HIDDEN fraction 0–100 (100 = fully clipped / empty bar).
 * Ball type is `BALL_DATA[caughtWith].type` (e.g. `poke` for `pokeb:pokeball`).
 *
 * UI Probe ground truth (fainted lv5 Bulbasaur from `generateRandomData` +
 * default `caughtWith` pokeball, location inventory):
 *   stats=`§7Fainted§r§f Lv. 5`, ball=`poke`, icon=`default/bulbasaur`
 * Empty ball on that wire is a viewer bug — not real-client correct.
 */

/** Empty party slot — same literals BEH emits. */
export const BEH_EMPTY_SLOT: readonly string[] = [
  "null",
  "null",
  "null",
  "false",
  "empty",
  "null",
  "100",
];

/**
 * Pad one sidebar field to 120 chars with `|` (BEH `padEnd(120, '|')`).
 *
 * @param value - Raw field value (must be ≤120).
 * @returns padded field.
 */
export function padBehSidebarField(value: string): string {
  return value.padEnd(120, "|");
}

/**
 * Pack 6×7 sidebar fields the way BEH does.
 *
 * @param slots - Exactly six slots of seven field strings each.
 * @returns packed sidebar body (no `&_sidebar:` prefix).
 */
export function packBehSidebar(slots: string[][]): string {
  if (slots.length !== 6) {
    throw new Error(`packBehSidebar: expected 6 slots, got ${slots.length}`);
  }
  for (const slot of slots) {
    if (slot.length !== 7) {
      throw new Error(
        `packBehSidebar: expected 7 fields per slot, got ${slot.length}`,
      );
    }
  }
  return slots
    .flat()
    .map((v) => padBehSidebarField(v))
    .join("|");
}

/**
 * One occupied slot with BEH-shaped strings.
 *
 * @param opts - Slot fields (clipPercent defaults to a partial bar).
 * @returns seven field strings.
 */
export function behOccupiedSlot(opts: {
  stats: string;
  nickname: string;
  species: string;
  active: boolean;
  /** `BALL_DATA[].type` — use `poke`, not `pokeball`. */
  ballType: string;
  icon: string;
  /** Hidden XP fraction 0–100. */
  clipPercent: string;
}): string[] {
  return [
    opts.stats,
    opts.nickname.startsWith("§f") ? opts.nickname : `§f${opts.nickname}`,
    opts.species,
    opts.active ? "true" : "false",
    opts.ballType,
    opts.icon,
    opts.clipPercent,
  ];
}
