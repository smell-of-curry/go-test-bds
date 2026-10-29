import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const filmDir = dirname(fileURLToPath(import.meta.url));

interface WireEntity {
  rid: number;
  type?: string;
  pos: [number, number, number];
  bbox?: [number, number];
  [key: string]: unknown;
}

interface WireFrame {
  v: number;
  type: string;
  bot: string;
  tick: number;
  entities?: WireEntity[];
  entitiesUpdated?: WireEntity[];
  actor?: unknown;
  [key: string]: unknown;
}

/**
 * Build a take from the Go encoder golden (`go-stream.jsonl`).
 *
 * The golden pig jumps once at tick 0 and is then removed, and its bbox is
 * `[0, 0]` so nothing would move on screen. This keeps that keyframe and the
 * pig's two recorded poses, gives the pig a visible box, and keeps stepping
 * the same delta so a 10-frame clip actually advances.
 *
 * @param dir - Take directory to create.
 * @returns the bot name written (`TestBot` in the golden).
 */
export function writeGoldenMotionTake(dir: string): string {
  const src = join(
    filmDir,
    "..",
    "..",
    "gotestbds",
    "viewer",
    "testdata",
    "go-stream.jsonl",
  );
  const lines = readFileSync(src, "utf8")
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as WireFrame);
  const key = lines.find((f) => f.type === "keyframe");
  if (!key || !key.entities) throw new Error(`no keyframe in ${src}`);
  const pig = key.entities.find((e) => e.type === "minecraft:pig");
  if (!pig) throw new Error("golden keyframe has no pig");
  const moved = lines.find((f) => f.entitiesUpdated)?.entitiesUpdated?.[0];
  if (!moved) throw new Error("golden stream has no pig move");
  const start: [number, number, number] = [pig.pos[0], pig.pos[1], pig.pos[2]];
  const end: [number, number, number] = [
    moved.pos[0],
    moved.pos[1],
    moved.pos[2],
  ];
  const step: [number, number, number] = [
    end[0] - start[0],
    end[1] - start[1],
    end[2] - start[2],
  ];
  pig.bbox = [0.9, 0.9];
  pig.pos = start;

  const frames: WireFrame[] = [key];
  // Same tick as the keyframe: lerp begins immediately, so frame 0 and frame 1 differ.
  for (let i = 0; i <= 8; i++) {
    const pos: [number, number, number] = [
      start[0] + step[0] * (i + 1),
      start[1] + step[1] * (i + 1),
      start[2] + step[2] * (i + 1),
    ];
    frames.push({
      v: 1,
      type: "delta",
      bot: key.bot,
      tick: key.tick + i,
      entitiesUpdated: [{ ...pig, pos, bbox: [0.9, 0.9] }],
      actor: key.actor,
    });
  }

  mkdirSync(dir, { recursive: true });
  const sse = frames
    .map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`)
    .join("");
  writeFileSync(join(dir, `${key.bot}.sse`), sse);
  writeFileSync(
    join(dir, "take.json"),
    JSON.stringify(
      {
        bots: [key.bot],
        startedAt: "1970-01-01T00:00:00.000Z",
        note: "go-stream.jsonl keyframe; pig bbox widened and retimed so the clip moves",
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "camera.json"),
    JSON.stringify(
      [
        {
          t: 0,
          pos: [2.5, 71.2, 8],
          yaw: 180,
          pitch: 7,
          fov: 50,
          ease: "linear",
        },
      ],
      null,
      2,
    ),
  );
  return key.bot;
}
