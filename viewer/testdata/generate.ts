/**
 * Hand-authored fixture generator for the Stage 2 smoke test.
 * Run: npm run generate:fixture
 *
 * Writes basic.jsonl (SSE payload lines) and expected.json (exact final counts).
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

interface Block {
  name: string;
  states: Record<string, string | number | boolean>;
  rid: number;
}

const AIR: Block = { name: "minecraft:air", states: {}, rid: 0 };
const STONE: Block = { name: "minecraft:stone", states: {}, rid: 1 };
const COBBLE: Block = { name: "minecraft:cobblestone", states: {}, rid: 2 };
const DIRT: Block = { name: "minecraft:dirt", states: {}, rid: 3 };
const OAK: Block = { name: "minecraft:oak_log", states: {}, rid: 4 };
const UNNAMED: Block = { name: "", states: {}, rid: 99999 };
const NETHERRACK: Block = { name: "minecraft:netherrack", states: {}, rid: 5 };

function sectionIndex(x: number, y: number, z: number): number {
  return (x << 8) | (z << 4) | y;
}

function encodeSection(
  palette: Block[],
  cells: Array<[number, number, number, number]>,
): {
  y: number;
  palette: Block[];
  blocks: string;
} {
  const indices = new Uint16Array(4096); // all air index 0
  for (const [x, y, z, pi] of cells) {
    indices[sectionIndex(x, y, z)] = pi;
  }
  const buf = Buffer.alloc(4096 * 2);
  for (let i = 0; i < 4096; i++) {
    buf.writeUInt16LE(indices[i]!, i * 2);
  }
  return { y: 4, palette, blocks: buf.toString("base64") };
}

function encodeSectionY(
  sy: number,
  palette: Block[],
  cells: Array<[number, number, number, number]>,
): { y: number; palette: Block[]; blocks: string } {
  const base = encodeSection(palette, cells);
  return { ...base, y: sy };
}

function actor(overrides: Record<string, unknown> = {}) {
  return {
    rid: 1,
    uid: 1,
    name: "TestBot",
    pos: [8.5, 65.0, 8.5],
    eyePos: [8.5, 66.62, 8.5],
    rot: [180.0, 20.0],
    vel: [0.0, 0.0, 0.0],
    onGround: true,
    gamemode: 0,
    dimension: 0,
    health: 20.0,
    maxHealth: 20.0,
    food: 20.0,
    heldSlot: 0,
    sneaking: false,
    sprinting: false,
    swimming: false,
    gliding: false,
    hotbar: [null, null, null, null, null, null, null, null, null],
    inventory: Array.from({ length: 36 }, () => null),
    offhand: null,
    armour: [null, null, null, null],
    effects: [],
    chunkRadius: 4,
    lookingAt: {
      pos: [1, 65, 1],
      face: "up",
      block: STONE,
    },
    ...overrides,
  };
}

function entity(
  rid: number,
  type: string,
  pos: [number, number, number],
  name: string,
) {
  return {
    rid,
    uid: -rid,
    type,
    pos,
    rot: [90.0, 0.0],
    vel: [0.0, -0.08, 0.0],
    bbox: [0.9, 0.9] as [number, number],
    name,
    player: false,
    flags: { onFire: false, sneaking: false },
    props: { variant: 0, markVariant: 0, scale: 1.0 },
    attributes: { health: 10.0, maxHealth: 10.0 },
    held: { main: null, off: null },
    armour: [null, null, null, null],
  };
}

const overworldSection = encodeSectionY(
  4,
  [AIR, STONE, UNNAMED],
  [
    [1, 1, 1, 1], // stone
    [3, 1, 1, 1], // stone
    [5, 1, 1, 1], // stone
    [7, 1, 1, 2], // unnamed → hot magenta
  ],
);

const partialSection = encodeSectionY(4, [AIR, DIRT], [[0, 0, 0, 1]]);

const addedSection = encodeSectionY(
  4,
  [AIR, OAK],
  [
    [0, 0, 0, 1],
    [2, 0, 0, 1],
  ],
);

// Wall of netherrack at eye height, 2 blocks south of the actor (−Z).
const netherSection = encodeSectionY(
  0,
  [AIR, NETHERRACK],
  [
    [5, 5, 3, 1],
    [6, 5, 3, 1],
    [7, 5, 3, 1],
    [8, 5, 3, 1],
    [9, 5, 3, 1],
    [5, 6, 3, 1],
    [6, 6, 3, 1],
    [7, 6, 3, 1],
    [8, 6, 3, 1],
    [9, 6, 3, 1],
  ],
);

const frames: unknown[] = [
  {
    v: 1,
    type: "hello",
    bot: "TestBot",
    schema: 1,
    tickRate: 20,
    radius: 4,
  },
  {
    v: 1,
    type: "keyframe",
    bot: "TestBot",
    tick: 100,
    world: {
      dimension: 0,
      dimensionName: "overworld",
      minY: -64,
      maxY: 319,
    },
    actor: actor(),
    columns: [
      {
        x: 0,
        z: 0,
        state: "complete",
        minY: -64,
        maxY: 319,
        sections: [overworldSection],
      },
      {
        x: 1,
        z: 0,
        state: "partial",
        minY: -64,
        maxY: 319,
        sections: [partialSection],
      },
      {
        x: 2,
        z: 0,
        state: "requested",
        minY: -64,
        maxY: 319,
        sections: [],
      },
    ],
    entities: [entity(41, "minecraft:pig", [12.5, 64.0, -8.5], "Porkchop")],
    ui: {
      messages: ["§afixture online"],
      title: "",
      subtitle: "",
      actionBar: "",
    },
  },
  {
    v: 1,
    type: "delta",
    bot: "TestBot",
    tick: 101,
    blocks: [
      {
        pos: [1, 65, 1],
        layer: 0,
        block: COBBLE,
      },
    ],
    actor: actor({
      lookingAt: { pos: [1, 65, 1], face: "up", block: COBBLE },
    }),
  },
  {
    v: 1,
    type: "delta",
    bot: "TestBot",
    tick: 102,
    columnsAdded: [
      {
        x: 0,
        z: 1,
        state: "complete",
        minY: -64,
        maxY: 319,
        sections: [addedSection],
      },
    ],
    actor: actor(),
  },
  {
    v: 1,
    type: "delta",
    bot: "TestBot",
    tick: 103,
    columnsRemoved: [[2, 0]],
    actor: actor(),
  },
  {
    v: 1,
    type: "delta",
    bot: "TestBot",
    tick: 104,
    entitiesAdded: [entity(42, "minecraft:cow", [10.0, 64.0, 10.0], "Bessie")],
    actor: actor(),
  },
  {
    v: 1,
    type: "delta",
    bot: "TestBot",
    tick: 105,
    entitiesUpdated: [
      entity(41, "minecraft:pig", [13.5, 64.0, -7.5], "Porkchop"),
    ],
    actor: actor(),
  },
  {
    v: 1,
    type: "delta",
    bot: "TestBot",
    tick: 106,
    entitiesRemoved: [41],
    actor: actor(),
  },
  {
    v: 1,
    type: "mark",
    bot: "TestBot",
    tick: 106,
    phase: "testEnd",
    runId: "run-fixture",
    suite: "viewer",
    test: "basic stream",
    status: "passed",
    message: "ok",
    elapsedMs: 12,
  },
  {
    v: 1,
    type: "capture",
    bot: "TestBot",
    id: "cap-fixture",
    minTick: 106,
    ext: "png",
    label: "smoke",
  },
  {
    v: 1,
    type: "delta",
    bot: "TestBot",
    tick: 200,
    world: {
      dimension: 1,
      dimensionName: "nether",
      minY: 0,
      maxY: 127,
    },
    columnsAdded: [
      {
        x: 0,
        z: 0,
        state: "complete",
        minY: 0,
        maxY: 127,
        sections: [netherSection],
      },
    ],
    entitiesAdded: [entity(50, "minecraft:magma_cube", [4.0, 4.0, 4.0], "Mag")],
    actor: actor({
      dimension: 1,
      // Face the wall at z≈3.5; eye height matches block centres at y≈5.5–6.5.
      pos: [7.5, 4.0, 7.5],
      eyePos: [7.5, 5.62, 7.5],
      rot: [180.0, 0.0],
      lookingAt: {
        pos: [7, 5, 3],
        face: "south",
        block: NETHERRACK,
      },
    }),
  },
];

const jsonl = frames.map((f) => JSON.stringify(f)).join("\n") + "\n";
writeFileSync(join(here, "basic.jsonl"), jsonl, "utf8");

/**
 * Final counts after the whole stream (post dimension-change delta).
 *
 * Nether column (0,0) section y=0 has 10 isolated netherrack → 10 instances, 1 section.
 * 1 entity (magma cube). resyncCount stays 0 (only one keyframe).
 */
const expected = {
  blockInstanceCount: 10,
  sectionMeshCount: 1,
  columnCount: 1,
  entityCount: 1,
  tick: 200,
  dimension: 1,
  schemaOk: true,
  resyncCount: 0,
  frames: frames.map((f) => (f as { type: string }).type),
};

writeFileSync(
  join(here, "expected.json"),
  JSON.stringify(expected, null, 2) + "\n",
  "utf8",
);
console.log("wrote basic.jsonl (%d frames) and expected.json", frames.length);
console.log(expected);
