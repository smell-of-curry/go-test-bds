# go-test-bds viewer

Read-only web renderer for the bot snapshot stream defined in [`PROTOCOL.md`](./PROTOCOL.md).
Stage 2 shell: coloured cubes, entity wire boxes, first-person + orbit camera, diagnostic overlay.

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
```

Keys: **C** toggles first-person (locked to actor `eyePos`/`rot`) ↔ orbit (drag to look, scroll to zoom). Actor body is drawn only in orbit mode.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc --noEmit` + Vite production build → `dist/` |
| `npm run preview` | Serve `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Playwright Chromium smoke test against the recorded fixture |
| `npm run generate:fixture` | Rebuild `testdata/basic.jsonl` + `expected.json` |

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
  meshSection(section, column): { meshes: InstancedMesh[]; instanceCount: number };
}
```

Air is skipped. A cell whose six **in-section** neighbours are all opaque is skipped (cheap interior cull). Cross-section / cross-column face culling is Stage 6.

## Smoke test / CI WebGL

`npm test` boots a tiny local SSE server that replays `testdata/basic.jsonl`, serves the app via Vite, and asserts exact `window.__viewer` counts from `testdata/expected.json`. It also writes `testdata/smoke.png` and samples canvas pixels so a blank clear-colour frame fails.

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
src/camera.ts     first-person + orbit
src/overlay.ts    diagnostic HUD
src/debug.ts      window.__viewer
src/main.ts       wiring
testdata/         recorded JSONL + expected counts + smoke.png
tests/            Playwright smoke + fixture SSE server
```
