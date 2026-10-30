import assert from "node:assert/strict";
import { test } from "node:test";
import { cameraClearance } from "./clearance";
import { takeMap } from "./map";
import { parseSse, timelineFromSse, timelineFromSseStream } from "./client";
import { filmFogRange, loadedDiscRadiusChunks } from "./fog";
import { hiddenEntityIds, hideNameSet } from "./hide";
import {
  columnNearPoints,
  rewriteTimelineForLookahead,
  sampleTrackPoints,
  type TimedFilmFrame,
} from "./lookahead";
import type { Actor, Column, DeltaFrame, KeyframeFrame } from "../src/protocol";

function actor(rid = 7, x = 8, z = 8): Actor {
  return {
    rid,
    uid: rid,
    name: "FilmCam",
    pos: [x, 64, z],
    eyePos: [x, 65.6, z],
    rot: [0, 0],
    vel: [0, 0, 0],
    onGround: true,
    gamemode: 0,
    dimension: 0,
    health: 20,
    maxHealth: 20,
    food: 20,
    heldSlot: 0,
    sneaking: false,
    sprinting: false,
    swimming: false,
    gliding: false,
    hotbar: [],
    inventory: [],
    offhand: null,
    armour: [null, null, null, null],
    effects: [],
    chunkRadius: 10,
  };
}

function col(x: number, z: number): Column {
  return { x, z, state: "complete", minY: 0, maxY: 15, sections: [] };
}

function kf(columns: Column[], who: Actor = actor()): TimedFilmFrame {
  const frame: KeyframeFrame = {
    v: 1,
    type: "keyframe",
    bot: "FilmCam",
    tick: 0,
    world: { dimension: 0, dimensionName: "overworld", minY: -64, maxY: 319 },
    actor: who,
    columns,
    entities: [],
  };
  return { tMs: 0, frame };
}

function delta(
  tMs: number,
  patch: Omit<DeltaFrame, "v" | "type" | "bot" | "tick">,
): TimedFilmFrame {
  const frame: DeltaFrame = {
    v: 1,
    type: "delta",
    bot: "FilmCam",
    tick: tMs / 50,
    ...patch,
  };
  return { tMs, frame };
}

const cam = [{ x: 8, z: 8 }];

test("clearance flags a lens inside or facing a block, not one in open air", () => {
  // Section 4 (y 64..79): a stone slab at y=66, air elsewhere.
  const idx = new Uint16Array(4096);
  for (let x = 0; x < 16; x++)
    for (let z = 0; z < 16; z++) idx[(x << 8) | (z << 4) | 2] = 1;
  const floor: Column = {
    ...col(0, 0),
    sections: [
      {
        y: 4,
        palette: [
          { name: "minecraft:air", states: {}, rid: 0 },
          { name: "minecraft:stone", states: {}, rid: 1 },
        ],
        blocks: Buffer.from(idx.buffer).toString("base64"),
      },
    ],
  };
  const at = (pos: [number, number, number], pitch: number) => [
    { t: 0, pos, yaw: 0, pitch, fov: 60 },
  ];
  const hits = (pos: [number, number, number], pitch: number) =>
    cameraClearance([kf([floor])], at(pos, pitch), 0, 0.1, 10, 9 / 16).length;
  assert.equal(hits([8, 66.5, 8], 0), 1, "lens inside stone");
  assert.equal(hits([8, 68, 8], 90), 1, "stone 1 block below, looking down");
  assert.equal(hits([8, 71, 8], 0), 0, "open air, looking level");
  assert.equal(
    hits([8, 75, 8], 90),
    0,
    "stone 9 blocks below is a view, not a wall",
  );
});

/** A column with one stone section; `blocks` varies the payload, `light` adds sky light. */
function edited(x: number, z: number, light?: string, blocks = "AAAA"): Column {
  return {
    ...col(x, z),
    sections: [
      {
        y: 4,
        palette: [{ name: "minecraft:stone", states: {}, rid: 1 }],
        blocks,
        skyLight: light,
      },
    ],
  };
}

test("take map draws the top block per cell, brighter when higher", () => {
  // Stone at y=66 everywhere in column (0,0), plus a pillar to y=70 at x=1,z=0.
  const idx = new Uint16Array(4096);
  for (let x = 0; x < 16; x++)
    for (let z = 0; z < 16; z++) idx[(x << 8) | (z << 4) | 2] = 1;
  for (let y = 2; y <= 6; y++) idx[(1 << 8) | y] = 1;
  const ground: Column = {
    ...col(0, 0),
    sections: [
      {
        y: 4,
        palette: [
          { name: "minecraft:air", states: {}, rid: 0 },
          { name: "minecraft:stone", states: {}, rid: 1 },
        ],
        blocks: Buffer.from(idx.buffer).toString("base64"),
      },
    ],
  };
  const { ppm, legend } = takeMap([kf([ground])], [0, 0, 1, 0]);
  const header = "P6 2 1 255\n";
  assert.equal(ppm.subarray(0, header.length).toString(), header);
  const px = ppm.subarray(header.length);
  assert.ok(
    px[3]! > px[0]!,
    "pillar top (y=70) brighter than the floor (y=66)",
  );
  assert.deepEqual(legend, [["minecraft:stone", 2]]);
  const empty = takeMap([kf([ground])], [16, 0, 16, 0]).ppm;
  assert.deepEqual(
    [...empty.subarray(header.length)],
    [0, 0, 0],
    "unloaded cell stays black",
  );
});

test("lookahead seeds the first column version and keeps later edits", () => {
  const first = edited(0, 0);
  const edited0 = edited(0, 0, undefined, "AQAB");
  const far = col(80, 80);
  const out = rewriteTimelineForLookahead(
    [
      kf([]),
      delta(1000, { columnsAdded: [first, far] }),
      delta(4000, { columnsAdded: [edited0] }),
    ],
    { fromMs: 2000, toMs: 5000, points: cam },
  );
  const key = out[0]!.frame;
  assert.equal(key.type, "keyframe");
  if (key.type !== "keyframe") return;
  assert.equal(key.columns.length, 1);
  assert.equal(key.columns[0], first);
  const late = out[2]!.frame;
  assert.equal(late.type, "delta");
  if (late.type !== "delta") return;
  assert.equal(late.columnsAdded?.[0], edited0);
  const arrive = out[1]!.frame;
  assert.equal(arrive.type, "delta");
  if (arrive.type !== "delta") return;
  assert.deepEqual(
    arrive.columnsAdded,
    [far],
    "seeded copy dropped, out-of-bubble column kept",
  );
});

test("lookahead seeds the complete column over an earlier requested shell", () => {
  const shell: Column = { ...col(0, 0), state: "requested" };
  const loaded = col(0, 0);
  const relit = col(0, 0);
  const out = rewriteTimelineForLookahead(
    [
      kf([]),
      delta(500, { columnsAdded: [shell] }),
      delta(3000, { columnsAdded: [loaded] }),
      delta(4000, { columnsAdded: [relit] }),
    ],
    { fromMs: 2000, toMs: 5000, points: cam },
  );
  const key = out[0]!.frame;
  assert.equal(key.type, "keyframe");
  if (key.type !== "keyframe") return;
  assert.equal(
    key.columns[0],
    relit,
    "same blocks, later light: the relit copy seeds",
  );
  for (const i of [1, 2, 3]) {
    const f = out[i]!.frame;
    assert.equal(
      f.type === "delta" && f.columnsAdded,
      undefined,
      `re-send ${i} dropped`,
    );
  }
});

test("lookahead folds a light refresh into the seed but keeps a block edit", () => {
  const dark = edited(0, 0);
  const lit = edited(0, 0, "//8=");
  const changed = edited(0, 0, undefined, "AQAB");
  const out = rewriteTimelineForLookahead(
    [
      kf([dark]),
      delta(3000, { columnsAdded: [lit] }),
      delta(4000, { columnsAdded: [changed] }),
    ],
    { fromMs: 2000, toMs: 5000, points: cam },
  );
  const key = out[0]!.frame;
  assert.equal(
    key.type === "keyframe" && key.columns[0],
    lit,
    "keyframe copy swapped for the lit seed",
  );
  const refresh = out[1]!.frame;
  assert.equal(
    refresh.type === "delta" && refresh.columnsAdded,
    undefined,
    "refresh dropped",
  );
  const edit = out[2]!.frame;
  assert.equal(
    edit.type === "delta" && edit.columnsAdded?.[0],
    changed,
    "block edit kept",
  );
});

test("lookahead does not drop an in-bubble column mid-window", () => {
  const near = col(0, 0);
  const out = rewriteTimelineForLookahead(
    [
      kf([near]),
      delta(1000, {
        columnsRemoved: [
          [0, 0],
          [80, 80],
        ],
      }),
      delta(5000, { columnsRemoved: [[0, 0]] }),
    ],
    { fromMs: 0, toMs: 5000, points: cam },
  );
  const mid = out[1]!.frame;
  assert.equal(mid.type, "delta");
  if (mid.type !== "delta") return;
  assert.deepEqual(mid.columnsRemoved, [[80, 80]]);
  const after = out[2]!.frame;
  assert.equal(after.type, "delta");
  if (after.type !== "delta") return;
  assert.deepEqual(after.columnsRemoved, [[0, 0]]);
});

test("lookahead leaves a column already on the keyframe un-duplicated", () => {
  const near = col(0, 0);
  const out = rewriteTimelineForLookahead([kf([near])], {
    fromMs: 0,
    toMs: 1000,
    points: cam,
  });
  const key = out[0]!.frame;
  assert.equal(key.type, "keyframe");
  if (key.type !== "keyframe") return;
  assert.equal(key.columns.length, 1);
  assert.equal(key.columns[0], near);
});

test("lookahead without a camera uses actor poses inside the window", () => {
  const near = col(1, -9);
  const out = rewriteTimelineForLookahead(
    [kf([], actor(7, 17, -135)), delta(3000, { columnsAdded: [near] })],
    { fromMs: 0, toMs: 1000, points: [] },
  );
  const key = out[0]!.frame;
  assert.equal(key.type, "keyframe");
  if (key.type !== "keyframe") return;
  assert.equal(key.columns[0], near);
});

test("lookahead radius is 20 chunks, inclusive", () => {
  assert.equal(columnNearPoints(20, 0, cam, 20), true);
  assert.equal(columnNearPoints(21, 0, cam, 20), false);
  assert.equal(columnNearPoints(-22, -1, [{ x: -8, z: -8 }], 20), false);
  assert.equal(columnNearPoints(-21, -1, [{ x: -8, z: -8 }], 20), true);
});

test("track samples stay on the segment", () => {
  const pts = sampleTrackPoints(
    [
      { t: 0, pos: [0, 0, 0] },
      { t: 1, pos: [10, 0, 0], ease: "inOutSine" },
    ],
    0,
    1,
  );
  assert.ok(pts[0]!.x === 0);
  assert.ok(pts[pts.length - 1]!.x === 10);
  for (const p of pts) assert.ok(p.x >= 0 && p.x <= 10);
});

test("film fog ends at the loaded radius and starts at 65%", () => {
  assert.deepEqual(filmFogRange(160), { near: 104, far: 160 });
  assert.deepEqual(filmFogRange(4), { near: 10.4, far: 16 });
});

test("film hides the recording bot across rids; live first-person hides the current one", () => {
  const entities = [
    { rid: 841, name: "FilmCam", player: true },
    { rid: 900, name: "FilmCam", player: true },
    { rid: 2211, name: "FilmCam2", player: true },
    { rid: 3, name: "FilmCam2", player: false },
  ];
  const self = hiddenEntityIds({
    entities,
    selfRids: new Set([841, 900]),
    currentActorRid: 900,
    hideSelf: true,
    hideAllSelfRids: true,
    names: hideNameSet(null),
  });
  assert.equal(self.has(841), true);
  assert.equal(self.has(900), true);
  assert.equal(self.has(2211), false);

  const shown = hiddenEntityIds({
    entities,
    selfRids: new Set([841]),
    currentActorRid: 841,
    hideSelf: false,
    hideAllSelfRids: true,
    names: hideNameSet("FilmCam2"),
  });
  assert.equal(shown.has(841), false);
  assert.equal(shown.has(2211), true);
  assert.equal(shown.has(3), false);

  const live = hiddenEntityIds({
    entities,
    selfRids: new Set([841, 900]),
    currentActorRid: 900,
    hideSelf: true,
    hideAllSelfRids: false,
    names: new Set(),
  });
  assert.deepEqual([...live], [900]);
});

test("SSE timeline matches when the body arrives in small chunks", async () => {
  const text = [
    "event: hello",
    'data: {"v":1,"type":"hello","bot":"Cam","schema":1,"tickRate":20,"radius":4}',
    "",
    ": keepalive",
    "",
    "event: delta",
    'data: {"v":1,"type":"delta","bot":"Cam","tick":3}',
    "",
  ].join("\n");
  const whole = timelineFromSse(text);
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 5) {
        controller.enqueue(bytes.subarray(i, i + 5));
      }
      controller.close();
    },
  });
  const chunked = await timelineFromSseStream(stream);
  assert.equal(parseSse(text).length, 2);
  assert.deepEqual(chunked, whole);
  assert.equal(whole.frames.length, 2);
  assert.equal(whole.firstTick, 0);
  assert.equal(whole.lastTick, 3);
});

test("fog disc follows what loaded, not the granted radius", () => {
  const disc = (r: number, skip?: string): string[] => {
    const keys: string[] = [];
    for (let x = -16; x <= 16; x++)
      for (let z = -16; z <= 16; z++)
        if (x * x + z * z <= r * r && `${x},${z}` !== skip)
          keys.push(`${x},${z}`);
    return keys;
  };
  assert.ok(Math.abs(loadedDiscRadiusChunks(disc(10), 0, 0, 16) - 10) < 0.3);
  assert.ok(
    Math.abs(loadedDiscRadiusChunks(disc(10, "1,0"), 0, 0, 16) - 10) < 0.3,
  );
  assert.ok(Math.abs(loadedDiscRadiusChunks(disc(16), 0, 0, 14) - 14) < 0.3);
});
