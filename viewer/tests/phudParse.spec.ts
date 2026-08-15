/**
 * Node-only unit tests for the PHUD wire parsers (no browser). Fixture
 * payloads are built exactly the way the behaviour-pack feeders build them
 * (sidebar.ts padEnd(120,'|'), topUiManager.ts padEnd(80,'_'),
 * BattleUtils.ts addMoveButton padEnd(30,'_')).
 */
import { expect, test } from "@playwright/test";
import {
  isBattleForm,
  parseBattleForm,
  parseBattleMoveButton,
  parseCurrency,
  parseSidebar,
  parseWaypoint,
  relativeBearing,
  waypointDistance,
} from "../src/ui/phud/parse";

/**
 * Build a sidebar payload the way events/sidebar.ts does.
 *
 * @param slots - Per-slot 7-field arrays.
 * @returns the packed `&_sidebar:` value.
 */
function packSidebar(slots: string[][]): string {
  return slots
    .flat()
    .map((v) => v.padEnd(120, "|"))
    .join("|");
}

const EMPTY_SLOT = ["null", "null", "null", "false", "empty", "null", "100"];

test("parseSidebar decodes occupied, egg and empty slots", () => {
  const payload = packSidebar([
    [
      "HP: 20/20§r§f Lv. 11",
      "§fBulbasaur \ue108",
      "bulbasaur",
      "true",
      "poke",
      "default/bulbasaur",
      "37",
    ],
    ["???", "§f???", "egg", "false", "poke", "default/egg", "100"],
    EMPTY_SLOT,
    EMPTY_SLOT,
    EMPTY_SLOT,
    EMPTY_SLOT,
  ]);

  const slots = parseSidebar(payload);
  expect(slots).toHaveLength(6);

  expect(slots[0]).toEqual({
    empty: false,
    stats: "HP: 20/20§r§f Lv. 11",
    name: "§fBulbasaur \ue108",
    species: "bulbasaur",
    selected: true,
    ball: "poke",
    sprite: "default/bulbasaur",
    xpClipPercent: 37,
  });
  expect(slots[1]?.species).toBe("egg");
  expect(slots[1]?.stats).toBe("???");
  expect(slots[1]?.xpClipPercent).toBe(100);
  for (const slot of slots.slice(2)) {
    expect(slot.empty).toBe(true);
    expect(slot.sprite).toBeNull();
    expect(slot.ball).toBe("empty");
  }
});

test("parseSidebar tolerates a truncated payload", () => {
  const slots = parseSidebar("");
  expect(slots).toHaveLength(6);
  expect(slots.every((s) => s.empty)).toBe(true);
});

test("parseSidebar maps legacy pokeball wire name to poke texture id", () => {
  const payload = packSidebar([
    [
      "§7Fainted§r§f Lv. 5",
      "§fBulbasaur",
      "bulbasaur",
      "true",
      "pokeball",
      "default/bulbasaur",
      "100",
    ],
    EMPTY_SLOT,
    EMPTY_SLOT,
    EMPTY_SLOT,
    EMPTY_SLOT,
    EMPTY_SLOT,
  ]);
  expect(parseSidebar(payload)[0]?.ball).toBe("poke");
  expect(parseSidebar(payload)[0]?.xpClipPercent).toBe(100);
});

test("parseCurrency splits the 80-char banner from the coin value", () => {
  const banner = "Buy Ranks, Crates, and more at §spokebedrock.com/shop§r";
  const value = banner.substring(0, 80).padEnd(80, "_") + " \ue10e 1.00K";
  expect(parseCurrency(value)).toEqual({
    banner,
    currency: "\ue10e 1.00K",
  });
});

test("parseCurrency handles a value without a currency half", () => {
  expect(parseCurrency("hello".padEnd(80, "_"))).toEqual({
    banner: "hello",
    currency: "",
  });
});

/**
 * Build one move button label the way BattleUtils.addMoveButton does.
 *
 * @param slot - Move slot 1–4.
 * @param type - Lowercase type.
 * @param moveId - Showdown move id.
 * @param pp - `pp/maxpp` string.
 * @param display - Resolved display text appended after the encoding.
 * @returns the flattened button label.
 */
function moveLabel(
  slot: number,
  type: string,
  moveId: string,
  pp: string,
  display: string,
): string {
  const data = [type, `.${moveId}`, pp].map((v) => v.padEnd(30, "_")).join(" ");
  return `b:${slot}_${data}${display}`;
}

test("parseBattleMoveButton decodes the padded move encoding", () => {
  const label = moveLabel(
    1,
    "normal",
    "growl",
    "40/40",
    "§lGrowl§r\nBase Power: 40\nAccuracy: 100%\nTarget: allAdjacentFoes\n\nLowers the foe(s) Attack by 1.",
  );
  const move = parseBattleMoveButton(0, label, "t__20");
  expect(move).toEqual({
    index: 0,
    slot: 1,
    type: "normal",
    moveId: "growl",
    pp: 40,
    maxpp: 40,
    name: "§lGrowl§r",
    description:
      "Base Power: 40\nAccuracy: 100%\nTarget: allAdjacentFoes\n\nLowers the foe(s) Attack by 1.",
    disabled: false,
    ppBar: 20,
  });
});

test("parseBattleForm decodes moves, tabs and the centre badge", () => {
  const buttons = [
    moveLabel(1, "normal", "growl", "40/40", "§lGrowl§r\ndesc"),
    moveLabel(2, "water", "watergun", "25/25", "§lWater Gun§r\ndesc"),
    moveLabel(3, "normal", "pound", "35/35", "§lPound§r\ndesc"),
    "battleButton:bagBag",
    "battleButton:pokemonSwitch Pokémon",
    "battleButton:runRun",
    "battleButton:move_selection",
  ];
  const images = ["t__20", "t__20", "f__10", "t", "f", "t", "t:_default"];

  expect(isBattleForm(buttons)).toBe(true);
  const battle = parseBattleForm(buttons, images);

  expect(battle.moves.map((m) => m.moveId)).toEqual([
    "growl",
    "watergun",
    "pound",
  ]);
  expect(battle.moves[1]?.type).toBe("water");
  expect(battle.moves[2]?.disabled).toBe(true);
  expect(battle.moves[2]?.ppBar).toBe(10);

  expect(battle.tabs).toEqual([
    { index: 3, kind: "bag", label: "Bag", disabled: false },
    { index: 4, kind: "pokemon", label: "Switch Pokémon", disabled: true },
    { index: 5, kind: "run", label: "Run", disabled: false },
  ]);
  expect(battle.ball).toEqual({
    index: 6,
    badge: "default",
    label: "",
    disabled: false,
  });
});

test("parseBattleForm classifies the bag tab even with unresolved lang keys", () => {
  const battle = parseBattleForm(
    ["battleButton:bagmodels.player.action.button.bag"],
    ["t"],
  );
  expect(battle.tabs[0]?.kind).toBe("bag");
});

test("isBattleForm is false for ordinary server forms", () => {
  expect(isBattleForm(["HP/PP Restore", "Poké Balls", "Back"])).toBe(false);
  expect(isBattleForm(undefined)).toBe(false);
});

test("parseWaypoint reads x,y,z|label and rejects junk", () => {
  expect(parseWaypoint("100.5,64,-20|PokeCenter")).toEqual({
    x: 100.5,
    y: 64,
    z: -20,
    label: "PokeCenter",
  });
  expect(parseWaypoint("1,2,3")).toEqual({ x: 1, y: 2, z: 3, label: "" });
  expect(parseWaypoint("clear")).toBeNull();
  expect(parseWaypoint("")).toBeNull();
});

test("relativeBearing follows the Bedrock yaw convention", () => {
  const pos: [number, number, number] = [0, 0, 0];
  // Yaw 0 faces +Z: a target dead ahead bears 0.
  expect(relativeBearing(pos, 0, { x: 0, y: 0, z: 10, label: "" })).toBeCloseTo(
    0,
  );
  // Facing +Z (south), west (−X) is to the right: +90.
  expect(
    relativeBearing(pos, 0, { x: -10, y: 0, z: 0, label: "" }),
  ).toBeCloseTo(90);
  // Facing −X (yaw 90), −X is dead ahead.
  expect(
    relativeBearing(pos, 90, { x: -10, y: 0, z: 0, label: "" }),
  ).toBeCloseTo(0);
  // Wrap-around stays in (−180, 180].
  expect(
    relativeBearing(pos, 170, { x: 0, y: 0, z: -10, label: "" }),
  ).toBeCloseTo(10);
});

test("waypointDistance is the rounded 3D distance", () => {
  expect(waypointDistance([0, 0, 0], { x: 3, y: 4, z: 0, label: "" })).toBe(5);
  expect(waypointDistance([1, 1, 1], { x: 1, y: 1, z: 1, label: "" })).toBe(0);
});
