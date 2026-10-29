# go-test-bds viewer

Read-only web renderer for the bot snapshot stream defined in [`PROTOCOL.md`](./PROTOCOL.md).
Stage 2 shell: coloured cubes, entity wire boxes, first-person / follow / orbit
camera, diagnostic overlay, caption band, block-change highlights, open-UI panel.

This package is **private** and is not part of the published `go-test-bds` SDK.
Install and run it only from this directory.

## Run

```bash
cd viewer
npm install
npm run generate:fixture   # regenerates testdata/basic.jsonl + expected.json
npm run dev                # http://127.0.0.1:5173
```

Point the app at a stream:

```
http://127.0.0.1:5173/?stream=http://127.0.0.1:24680/stream?bot=TestBot
```

Or, when the page is served from the bot process itself (`GET /` with `--viewer-app`):

```
http://127.0.0.1:24680/?bot=TestBot
http://127.0.0.1:24680/?bot=TestBot&camera=follow
```

| Query | Values | Default |
| --- | --- | --- |
| `camera` | `follow` \| `first` / `firstPerson` \| `orbit` | `firstPerson` |

Capture harness always opens with `camera=follow`. Keys: **C** cycles
first-person (locked to actor `eyePos`/`rot`) → follow (over-the-shoulder) →
orbit (drag to look, scroll to zoom). Actor body is drawn in follow and orbit.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc --noEmit` + Vite production build → `dist/` |
| `npm run build:capture` | Bundle the headless capture CLI → `dist-capture/cli.cjs` |
| `npm run preview` | Serve `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Playwright smoke + capture-harness tests against local fixtures |
| `npm run generate:fixture` | Rebuild `testdata/basic.jsonl` + `expected.json` |

## Capture harness

Headless Chromium process that turns the SSE stream into one run webm + stills
and `POST`s them to the bot's `/artifact` endpoint. See [`PROTOCOL.md`](./PROTOCOL.md)
§ "The capture harness".

```bash
npm run build:capture
node dist-capture/cli.cjs --stream http://127.0.0.1:24680 --bot TestBot
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--stream` | required | Bot viewer base URL; opens `<stream>/?bot=<bot>&camera=follow` |
| `--bot` | required | Bot name |
| `--width` / `--height` | `1280` / `720` | Viewport + `recordVideo` size |
| `--max-segment-seconds` | `120` | Caps the whole-run recording; closes the stream and uploads |
| `--browser` | Playwright Chromium | Then `PLAYWRIGHT_CHROMIUM`, then `CHROME_PATH` |
| `--video-out` | unset | Write the run video here instead of POSTing it; the bot exits with the run, so anything finalised at shutdown needs this |
| `--log-level` | `info` | `debug` \| `info` \| `warn` \| `error` |

Video uses Playwright `recordVideo` on the **same** long-lived context as stills
(whole page, including the DOM diagnostic / mark overlay). One webm is uploaded
when the stream closes — not per test. Mark phases stay burnt into the overlay
so a viewer can tell which test is on screen.

The app paints on `requestAnimationFrame` and interpolates actor/entity poses
between snapshots (block meshes still update only when data changes, under the
remesh budget). Playwright writes the webm at 25 fps, so a quiet stretch of a
run can still look short — read the caption's elapsed time and the overlay
`tick` for real timing.

## Film mode

Offline, frame-exact render of a recorded take. No live bot. The page clock is
Playwright's (`install` at t=0, then `runFor` one output step at a time), so
motion lerp, animation, particles, and the sky all read virtual time.
`?film=1` does not open an EventSource: the page fetches `GET /film/sse?bot=`
and applies frames from `window.__film` when their tick is due
(`(tick - firstKeyframeTick) * 50` ms). The Playwright clock is installed and
paused, then stepped with `runFor`. `performance.now` is pinned to the output
timestamp on top of that, because the clock's install log replays the wall gap
between `install` and `pauseAt` (about 1 ms) and that is enough to make two
runs disagree. Each output frame is `canvas.toDataURL` in the same turn as the
draw (`preserveDrawingBuffer` is already on). Diagnostic UI, HUD, crosshair, and name tags are hidden;
`--hud` / `--nametags` put those back. View bobbing stays off. The default
camera is the actor (first person), including server camera instructions.
`--camera camera.json` replaces that with an authored track.

```bash
npm run film -- render \
  --take ./take --bot TestBot \
  --from 0 --to 8 \
  --width 1080 --height 1920 --fps 60 \
  --camera camera.json \
  --out ./shorts/clip.mp4
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--from` / `--to` | required | Seconds (`1.5`, `1.5s`) or absolute server ticks (`30t`, `30tick`). The range is half-open. Tick `0` of the take is the first keyframe, so `--from 0` and `--from <that tick>t` are the same instant |
| `--hide <name,...>` | none | Also omit these player entities (body, name tag, shadow) |
| `--show-self` | off | Draw the recording bot. Default hides `actor.rid` for the whole take, including rejoins |
| `--lookahead` / `--no-lookahead` | on | In-camera columns that arrive later in the take are shown from the start of the window at their first version. Later block edits still apply on time. Columns the bot walks away from stay up through `--to` |
| `--width` / `--height` / `--fps` | `1080` / `1920` / `60` | `devicePixelRatio` is 1. Odd sizes are padded by one pixel only when encoding yuv420p |
| `--out` | required | A directory of `frame_%05d.png` (from 0), or a `.mp4` (H.264 yuv420p CRF 16, no audio; PNGs in `frames/` beside it) |
| `--gpu` | SwiftShader | ANGLE Metal / the default GPU |
| `--dev` | off | Vite instead of `viewer/dist` |
| `--packs-from <url>` | off | Mirror whatever the app requests into `<take>/packs-mirror/` |

Packs, when present, are served on the same origin. `take.json` `cacheDir` is
the Go cache (`packs/<uuid>/<version>/`) and `baselineTag` selects
`../.cache/baseline/<tag>/resource_pack` (tier 5 subpack, same rule as the
hub). `packs.json` is the `GET /packs` body and names which cached packs are
on the stack. If that cache is not on this machine, point `--packs-from` at a
live hub once; later runs read `<take>/packs-mirror/`. No packs is a 404 and
the app draws placeholder cubes — the determinism test uses that path.

Warm-up applies every frame before `--from`, waits until
`window.__viewer.assetsSettled` and the remesh queue is empty, then presents.
The first saved frame is not the loading screen.

```bash
npm run test:film
```

## Frame budget and chunk update strategy

Decided for Stage 2 (placeholder cubes). Stage 6 replaces the mesher insides; the seam stays "dirty section key → meshes".

| Knob | Value | Why |
| --- | --- | --- |
| Target frame time | **16 ms** (60 Hz) | Interactive inspection + headless capture later |
| Remesh budget / frame | **4 ms** wall time, max **8 sections** | Keep input/camera responsive while chunks stream in |
| When a section remeshes | Member of the store's dirty-section set (block change, column add, keyframe, dimension wipe) | Never full-world rebuild on a single block update |
| Worker pool | **Not yet** | Placeholder mesher is an O(4096) scan per section; main-thread budget is enough for a few hundred dirty sections/s. Stage 6 (greedy mesh, atlas UVs) revisits workers if profiling says so |

Interface kept narrow on purpose:

```ts
interface Mesher {
  meshSection(section, column, state): { meshes: Mesh[]; instanceCount: number };
}
```

Air is skipped. Only faces exposed to air (or the edge of known data) are
emitted — buried cells contribute nothing. Unknown / not-yet-received neighbour
columns count as exposed so the loaded frontier stays visible; when they arrive
the store dirties both sides. Block changes on a section edge remesh the
neighbour section.

## Smoke test / CI WebGL

`npm test` boots a tiny local SSE server that replays `testdata/basic.jsonl`, serves the app via Vite, and asserts exact `window.__viewer` counts from `testdata/expected.json`. It also writes `testdata/smoke.png` and samples canvas pixels so a blank clear-colour frame fails.

A second Playwright test replays the Go encoder golden at `../gotestbds/viewer/testdata/go-stream.jsonl` over the same SSE stub and asserts `schemaOk` plus the fixture's last tick — proving the app parses the real wire format offline.

`window.__viewer` is assigned at startup with `schemaOk: false`. After frames arrive it also exposes `framesReceived` and `lastError` so a capture-harness timeout can say why readiness never came.

Headless Chromium needs a software GL backend on GPU-less runners. The Playwright config passes:

```
--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
```

Do **not** run `npx playwright install` unless `npm test` says the browser is missing; Chromium is expected to already be cached on developer machines.

## Layout

```
src/protocol.ts   frame/object types (PROTOCOL.md)
src/stream.ts     EventSource client
src/store.ts      keyframe/delta world model
src/scene.ts      three.js + PlaceholderMesher
src/camera.ts     first-person + follow + orbit
src/motion.ts     pose interpolation between snapshots
src/overlay.ts    diagnostic HUD + caption band + UI panel
src/debug.ts      window.__viewer
src/main.ts       wiring (rAF paint loop)
capture/          headless capture CLI (bundled to dist-capture/cli.cjs)
testdata/         recorded JSONL + expected counts + smoke.png
tests/            Playwright smoke + Go golden stream + capture harness + fixture SSE server
```

