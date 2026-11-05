import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cameraClearance } from "./clearance";
import { timelineFromSse } from "./client";
import { takeMap } from "./map";
import { filmOutputSelection, parseFilmRanges, renderFilm } from "./render";
import { boundToMs, parseBound } from "./time";

const HELP = `Usage: npm run film -- render --take <dir> --bot <name> --from <time> --to <time> --out <dir|file.mp4>
       npm run film -- render --take <dir> --bot <name> --ranges <file.json> --out <dir|file.mp4>
       npm run film -- check --take <dir> --bot <name> --from <time> --to <time> --camera <file> [--fps n]

Render a recorded take offline, frame-exact, with no live bot.

       npm run film -- map --take <dir> --bot <name> --area x0,z0,x1,z1 --out <file.ppm>

check replays the take without a browser and lists camera samples whose lens
sits inside a drawn block (exit 1 when any). Run it before a render.

map writes a top-down scouting map of the take's world (one pixel per block,
north up, brighter = higher) and prints the most common top blocks. Scale it
up with ffmpeg -vf scale=iw*6:ih*6:flags=neighbor to read it.

  --take <dir>          Take directory (<bot>.sse, take.json, skins/, packs.json)
  --bot <name>          Bot whose <name>.sse to play
  --from <time>         Start. Seconds (1.5, 1.5s) or server ticks (30t, 30tick)
  --to <time>           End, exclusive, same units
  --ranges <file>       Ordered [{from,to}, ...] windows instead of --from/--to
  --out <path>          PNG directory, or an .mp4 (frames written beside it in frames/)
  --width <n>           Default 1080
  --height <n>          Default 1920
  --fps <n>             Default 60
  --camera <file>       JSON keyframes [{t, pos, yaw, pitch, fov, ease}]
  --gpu                 ANGLE Metal. Default is SwiftShader
  --hud                 Capture game HUD/forms with the world (requires Mojangles)
  --nametags            Keep name tags (hidden by default)
  --hide <name,...>     Also hide these player names (default none)
  --show-self           Draw the recording bot (hidden by default)
  --lookahead           Show later chunks from the start of the window (default)
  --no-lookahead        Stream chunks as the bot received them
  --dev                 Serve the Vite app instead of viewer/dist
  --app <dir>           Built app directory (default viewer/dist)
  --packs-from <url>    Mirror hub pack responses into <take>/packs-mirror/
  --extensions <dir>   Viewer extension files (default <take>/extensions/)
  --font-dir <dir>     Host-owned TTFs (default <take>/fonts/)
  --help

Time is milliseconds after the first keyframe. A tick flag is an absolute
server tick: (tick - firstKeyframeTick) * 50. The page clock is paused and
advanced with Playwright runFor, one output frame per 1000/fps ms.
Ranges concatenate their frame grids, advancing the source clock through gaps.
They share one bot, camera timeline, viewport and lookahead over the overall bounds.
Range numbers are seconds; strings also accept tick units. Overlap/order errors fail.
check also accepts --ranges to inspect only the selected windows.

Packs: take.json cacheDir + baselineTag, else <take>/packs-mirror/, else
--packs-from. No packs → placeholder cubes.
`;

interface Flags {
  take?: string;
  bot?: string;
  from?: string;
  to?: string;
  ranges?: string;
  out?: string;
  width: number;
  height: number;
  fps: number;
  camera?: string;
  gpu: boolean;
  hud: boolean;
  nametags: boolean;
  hide?: string;
  showSelf: boolean;
  lookahead: boolean;
  dev: boolean;
  app?: string;
  area?: string;
  packsFrom?: string;
  extensionsDir?: string;
  fontDir?: string;
  help: boolean;
}

/**
 * @param argv - Arguments after the node binary.
 * @returns parsed flags.
 */
function parseArgs(argv: string[]): Flags {
  const rest =
    argv[0] === "render" || argv[0] === "check" || argv[0] === "map"
      ? argv.slice(1)
      : argv;
  const flags: Flags = {
    width: 1080,
    height: 1920,
    fps: 60,
    gpu: false,
    hud: false,
    nametags: false,
    showSelf: false,
    lookahead: true,
    dev: false,
    help: false,
  };
  const next = (i: number, name: string): string => {
    const v = rest[i];
    if (v === undefined) throw new Error(`missing value for ${name}`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--help" || a === "-h") {
      flags.help = true;
      continue;
    }
    if (a === "--gpu") {
      flags.gpu = true;
      continue;
    }
    if (a === "--hud") {
      flags.hud = true;
      continue;
    }
    if (a === "--nametags") {
      flags.nametags = true;
      continue;
    }
    if (a === "--show-self") {
      flags.showSelf = true;
      continue;
    }
    if (a === "--lookahead") {
      flags.lookahead = true;
      continue;
    }
    if (a === "--no-lookahead") {
      flags.lookahead = false;
      continue;
    }
    if (a === "--hide") {
      flags.hide = next(++i, a);
      continue;
    }
    if (a === "--dev") {
      flags.dev = true;
      continue;
    }
    if (a === "--take") {
      flags.take = next(++i, a);
      continue;
    }
    if (a === "--bot") {
      flags.bot = next(++i, a);
      continue;
    }
    if (a === "--from") {
      flags.from = next(++i, a);
      continue;
    }
    if (a === "--to") {
      flags.to = next(++i, a);
      continue;
    }
    if (a === "--ranges") {
      flags.ranges = next(++i, a);
      continue;
    }
    if (a === "--out") {
      flags.out = next(++i, a);
      continue;
    }
    if (a === "--width") {
      flags.width = Number(next(++i, a));
      continue;
    }
    if (a === "--height") {
      flags.height = Number(next(++i, a));
      continue;
    }
    if (a === "--fps") {
      flags.fps = Number(next(++i, a));
      continue;
    }
    if (a === "--camera") {
      flags.camera = next(++i, a);
      continue;
    }
    if (a === "--app") {
      flags.app = next(++i, a);
      continue;
    }
    if (a === "--area") {
      flags.area = next(++i, a);
      continue;
    }
    if (a === "--packs-from") {
      flags.packsFrom = next(++i, a);
      continue;
    }
    if (a === "--extensions") {
      flags.extensionsDir = next(++i, a);
      continue;
    }
    if (a === "--font-dir") {
      flags.fontDir = next(++i, a);
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }
  return flags;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (process.argv[2] === "check") return check(flags);
  if (process.argv[2] === "map") return map(flags);
  if (
    !flags.take ||
    !flags.bot ||
    (!flags.ranges && (!flags.from || !flags.to)) ||
    !flags.out
  ) {
    process.stderr.write(HELP);
    throw new Error(
      "--take, --bot, --out, and either --from/--to or --ranges are required",
    );
  }
  const result = await renderFilm({
    takeDir: flags.take,
    bot: flags.bot,
    from: flags.from,
    to: flags.to,
    ranges: flags.ranges
      ? parseFilmRanges(JSON.parse(readFileSync(flags.ranges, "utf8")))
      : undefined,
    out: flags.out,
    width: flags.width,
    height: flags.height,
    fps: flags.fps,
    cameraPath: flags.camera,
    gpu: flags.gpu,
    hud: flags.hud,
    nametags: flags.nametags,
    hide: flags.hide,
    showSelf: flags.showSelf,
    lookahead: flags.lookahead,
    dev: flags.dev,
    appDir: flags.app,
    packsFrom: flags.packsFrom,
    extensionsDir: flags.extensionsDir,
    fontDir: flags.fontDir,
  });
  process.stdout.write(
    `${result.frames} ${result.width}x${result.height} → ${result.mp4 ?? result.frameDir}\n`,
  );
}

function check(flags: Flags): void {
  if (
    !flags.take ||
    !flags.bot ||
    (!flags.ranges && (!flags.from || !flags.to)) ||
    !flags.camera
  ) {
    process.stderr.write(HELP);
    throw new Error(
      "check needs --take, --bot, --camera, and either --from/--to or --ranges",
    );
  }
  const { frames, firstTick } = timelineFromSse(
    readFileSync(join(flags.take, `${flags.bot}.sse`), "utf8"),
  );
  const selection = flags.ranges
    ? filmOutputSelection(
        {
          ranges: parseFilmRanges(
            JSON.parse(readFileSync(flags.ranges, "utf8")),
          ),
          from: flags.from,
          to: flags.to,
          fps: flags.fps,
        },
        firstTick,
      )
    : {
        ranges: [
          {
            fromMs: boundToMs(parseBound(flags.from!), firstTick),
            toMs: boundToMs(parseBound(flags.to!), firstTick),
          },
        ],
      };
  const keys = JSON.parse(readFileSync(flags.camera, "utf8"));
  const hits = selection.ranges.flatMap(({ fromMs, toMs }) =>
    cameraClearance(
      frames,
      keys,
      fromMs / 1000,
      toMs / 1000,
      flags.fps,
      flags.width / flags.height,
    ),
  );
  for (const h of hits)
    process.stdout.write(
      `${h.tSec.toFixed(3)}s lens [${h.pos.map((v) => v.toFixed(2)).join(", ")}] in ${h.block} @ ${h.at.join(" ")}\n`,
    );
  process.stdout.write(
    `clearance: ${hits.length} blocked sample(s) in ${selection.ranges.map((r) => `${(r.fromMs / 1000).toFixed(2)}..${(r.toMs / 1000).toFixed(2)}s`).join(", ")}\n`,
  );
  if (hits.length) process.exitCode = 1;
}

function map(flags: Flags): void {
  const area = flags.area?.split(",").map(Number);
  if (
    !flags.take ||
    !flags.bot ||
    !flags.out ||
    area?.length !== 4 ||
    area.some((v) => !Number.isFinite(v))
  ) {
    process.stderr.write(HELP);
    throw new Error("map needs --take, --bot, --area x0,z0,x1,z1, and --out");
  }
  const [x0, z0, x1, z1] = area as [number, number, number, number];
  const { frames } = timelineFromSse(
    readFileSync(join(flags.take, `${flags.bot}.sse`), "utf8"),
  );
  const { ppm, legend } = takeMap(frames, [
    Math.min(x0, x1),
    Math.min(z0, z1),
    Math.max(x0, x1),
    Math.max(z0, z1),
  ]);
  writeFileSync(flags.out, ppm);
  process.stdout.write(
    `${flags.out}\n${legend
      .slice(0, 12)
      .map(([n, c]) => `${n.replace("minecraft:", "")}:${c}`)
      .join(" ")}\n`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
