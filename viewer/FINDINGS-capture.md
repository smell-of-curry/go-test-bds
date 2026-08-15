# Findings — Stage 3 capture

Answers the three Capture research items in [`PLAN.md`](./PLAN.md) plus video and defaults.
Protocol contracts cited from [`PROTOCOL.md`](./PROTOCOL.md): `capture` frame (`minTick`), `POST /artifact`, `POST /capture/<id>/error`, `screenshot` instruction.

---

## 1. Which headless capture mechanism matches the interactive path?

### (a) Headless Chromium + Playwright/Puppeteer + CDP `Page.captureScreenshot`

| Question | Answer |
| --- | --- |
| Needs GPU? | No, if SwiftShader/ANGLE software path is forced |
| GPU-less Linux CI? | Yes — Chromium ships SwiftShader; must opt in (see flags below) |
| Byte-identical to interactive? | **Only when GL backend, DPR, antialias, and Chromium build match.** Same machine + same flags → yes. Local GPU headed vs CI SwiftShader → no (1–3% pixel churn observed: [rgis SwiftShader CI commit](https://github.com/rgis-app/rgis/commit/a94e1905e9f70e97e48cd9f440561c3b3ca318c8)) |
| What breaks it? | Blank/black canvas if buffer cleared before read ([blank screenshot writeups](https://screenshotrun.com/blog/puppeteer-playwright-blank-white-screenshots)); missing `--enable-unsafe-swiftshader` after Chrome ~130 ([Chromium SwiftShader docs](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md), [Intent to Remove](https://groups.google.com/a/chromium.org/g/blink-dev/c/yhFguWS_3pM)); using `chrome-headless-shell` instead of new headless (different GPU/compositor path — [Currents: headless vs headed](https://currents.dev/posts/when-tests-should-run-headless-vs-headed-in-playwright), [Chrome headless docs](https://developer.chrome.com/docs/chromium/headless)); DPR ≠ 1; antialias on |

Playwright itself ships a WebGL screenshot fixture that asserts snapshots work under Chromium ([`page-screenshot.spec.ts`](https://github.com/microsoft/playwright/blob/main/tests/page/page-screenshot.spec.ts)). Capture is of the **composited page** (canvas + CSS overlays), not raw GL backbuffer.

**SwiftShader / ANGLE flags (CI):**

```
--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
--force-device-scale-factor=1
```

([Chromium SwiftShader docs](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md); Map Visual Regression guide prefers the same spelling: [MVR WebGL noise reduction](https://www.mapvisualregression.org/screenshot-capture-sync-comparison-logic/noise-reduction-for-map-artifacts/reducing-false-positives-from-webgl-rendering-artifacts/)).

Assert at runtime: `WEBGL_debug_renderer_info` / `UNMASKED_RENDERER_WEBGL` contains `SwiftShader` (same MVR guide). Silent GPU-blocklist fallback to a flat 2D path is a known footgun ([Microlink: WebGL without a GPU](https://microlink.io/blog/webgl-without-a-gpu)).

**`chrome-headless-shell` vs `--headless=new`:** Old headless is now the separate `chrome-headless-shell` binary ([Chrome headless](https://developer.chrome.com/docs/chromium/headless)). New headless is the real `//chrome` browser without windows — closer to interactive. Shell is lighter but weaker/different for WebGL/GPU ([Currents](https://currents.dev/posts/when-tests-should-run-headless-vs-headed-in-playwright), [Promaton GPU CI](https://blog.promaton.com/testing-3d-applications-with-playwright-on-gpu-1e9cfc8b54a9)). **Use full Chromium new headless for the viewer harness, not shell.**

### (b) In-page `canvas.toDataURL()` / `canvas.toBlob()` + `preserveDrawingBuffer`

| Question | Answer |
| --- | --- |
| Needs GPU? | Same as the page’s WebGL context (none if SwiftShader) |
| GPU-less CI? | Yes, under same Chromium flags as (a) |
| Byte-identical to interactive? | **Yes for canvas pixels**, if capture runs in the same JS path (interactive and harness both call the same helper). Differs from (a) when HUD/CSS overlays or devicePixelRatio scaling are in play |
| What breaks it? | Calling after the browser has cleared the drawing buffer ([WebGL fundamentals tips](https://webglfundamentals.org/webgl/lessons/webgl-tips.html), [SO: blank toDataURL](https://stackoverflow.com/questions/12538193/why-does-my-canvas-go-blank-after-converting-to-image)); `premultipliedAlpha` quirks on some headless stacks ([SO: headless WebGL](https://stackoverflow.com/questions/48011613/rendering-webgl-image-in-headless-chrome-without-a-gpu)) |

WebGL default: after the rAF/event returns, the drawing buffer may be cleared; late `toDataURL`/`toBlob`/`readPixels` is undefined unless `preserveDrawingBuffer: true` **or** capture happens in the same turn as the draw ([spec behaviour summarised in the SO/WebGLFundamentals links above]).

### (c) Native GL in Node (`headless-gl`, `node-canvas` + WebGL)

| Question | Answer |
| --- | --- |
| Needs GPU? | No — Mesa/ANGLE software ([headless-gl README](https://github.com/stackgl/headless-gl)) |
| GPU-less CI? | Yes, with mesa/xvfb caveats on some Linux images |
| Byte-identical to interactive Chromium? | **No.** Different process, no Blink compositor, often WebGL1-only ([infinite-canvas lesson](https://infinitecanvas.cc/guide/lesson-011.html)). Useful for SSR/unit GL tests; not for “looks like the viewer tab” |
| What breaks it? | WebGL2/WebGPU features, DOM/UI, pack-driven texture decode paths that assume browser APIs |

### Recommendation

**Primary stills: (b) in-page `canvas.toBlob('image/png')` inside the viewer’s present path, driven by Playwright Chromium new headless with SwiftShader flags.**

Reason: same JS capture path for interactive and CI → canvas pixels match by construction; harness already owns `POST /artifact` with raw PNG bytes ([PROTOCOL.md](./PROTOCOL.md)); no second compositor path to reconcile. Use CDP `Page.captureScreenshot` / `locator.screenshot()` only for HUD-inclusive diagnostics, not goldens.

Reject (c) for Stage 3: cannot match interactive Blink output.

Cheapest settle experiment if disputed: pin Chromium, force SwiftShader, render a fixed cube fixture twice — once headed with those flags, once headless — `sha256` the `toBlob` PNGs; then diff against a GPU-headed capture (expect mismatch).

---

## 2. Deterministic screenshot vs bot tick; failure when tick never renders

### Protocol (already normative)

[`capture` frame](./PROTOCOL.md): `{ id, minTick, … }`. Harness must not `POST /artifact` until it has rendered a frame from a snapshot with `tick >= minTick`. Else `POST /capture/<id>/error` with a message. `screenshot` defaults `timeoutMs: 5000`. Answering early is a lie; hanging is forbidden.

### What “presented frame for tick T” means in-page

1. SSE applies a `keyframe`/`delta` whose `tick` is `T' >= minTick` into scene state. Stamp `lastAppliedTick = T'`.
2. **Drawing is not presentation.** Issuing WebGL commands does not mean the browser has composited, and with `preserveDrawingBuffer: false` the buffer may already be gone when a later task runs ([WebGL fundamentals](https://webglfundamentals.org/webgl/lessons/webgl-tips.html)).
3. **rAF ordering:** schedule present in `requestAnimationFrame`. After all draw calls for that snapshot, still in that rAF callback, either:
   - call `toBlob` / `readPixels` immediately (same-turn capture — works even without `preserveDrawingBuffer`), **or**
   - rely on `preserveDrawingBuffer: true` and capture after a **double rAF** if an external agent (CDP screenshot) reads the canvas later ([double-rAF heuristic](https://screenshotrun.com/blog/puppeteer-playwright-blank-white-screenshots)).
4. **`gl.finish()`:** blocks until the GL command queue completes. Useful belt-and-suspenders before readback on real GPUs; with SwiftShader most work is already CPU-sync. Not a substitute for rAF/present ordering; optional after draws, before `toBlob`.
5. **`preserveDrawingBuffer: true`:** required if any capture path reads the canvas *after* the presenting event returns (CDP screenshot from Node, deferred POST). Cost: forces copy instead of swap ([SO explanation](https://stackoverflow.com/questions/32556939/saving-canvas-to-image-via-canvas-todataurl-results-in-black-rectangle)). Accept for the viewer; Stage 3 capture reliability > micro-optimisation.

Stamp every presented frame: `lastPresentedTick` set only at the end of the rAF that drew `lastAppliedTick`. Fulfil capture only when `lastPresentedTick >= minTick`.

### Timeout / error path

- Start timer at `capture` receipt (`timeoutMs` from instruction, default 5000).
- If timer fires and `lastPresentedTick < minTick`: `POST /capture/<id>/error` with body like `{"message":"no canvas frame reached tick 1024 within 5000ms"}` ([PROTOCOL.md](./PROTOCOL.md)).
- Causes: no subscriber / page crashed; stream backpressure dropping frames then resync still below `minTick`; rAF starved (tab backgrounded — use CDP `Page.setWebLifecycleState` / bring-to-front); WebGL context lost; bot tick advanced but viewer never applied (JS error).
- Never resolve the instruction with a stale PNG.

### Ordering rule (implementer checklist)

1. On `capture` `{id, minTick}`: register pending capture; start `timeoutMs` timer.
2. Keep applying SSE snapshots; update `lastAppliedTick`.
3. Each animation frame: if scene dirty or pending capture waiting, render from current snapshot state.
4. End of that rAF, after draws (+ optional `gl.finish()`): set `lastPresentedTick = lastAppliedTick`.
5. If pending and `lastPresentedTick >= minTick`: `canvas.toBlob('image/png')` → `POST /artifact` with `X-Capture-Id`, `X-Artifact-Tick: <lastPresentedTick>`, kind/ext/bot headers → clear pending.
6. If timer fires first: `POST /capture/<id>/error`; clear pending; do **not** POST a PNG.

---

## 3. Video headless, per-test, without host ffmpeg

### (a) In-page `MediaRecorder` + `canvas.captureStream(fps)`

| Topic | Evidence |
| --- | --- |
| Headless | `getDisplayMedia` fails headless ([puppeteer#4404](https://github.com/GoogleChrome/puppeteer/issues/4404)); **canvas `captureStream` does not need a display** ([Chrome captureStream blog](https://developer.chrome.com/blog/capture-stream), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream)) |
| Codecs | Chromium: `video/webm;codecs=vp8` and `vp9` ([Chrome MediaRecorder blog](https://developer.chrome.com/blog/mediarecorder)). Prefer **VP8** for max tooling compatibility; probe with `MediaRecorder.isTypeSupported` |
| SwiftShader | Encoding is CPU software in Chromium; independent of GL backend. Must keep painting while recording or Chrome may emit empty webm ([SO: must keep drawing](https://stackoverflow.com/questions/66813248/video-capture-of-canvas-element-by-mediastream-recording-api-is-not-working)) |
| Per-test start/stop | On `mark` `testStart` → `recorder.start(timeslice)`; on `testEnd` → `recorder.stop()`; gather `dataavailable` Blobs → one `Blob` → `arrayBuffer` → `POST /artifact` (`X-Artifact-Kind: video`, `ext: webm`) |
| Bytes to Node | `page.evaluate` returning base64 is heavy; better: Playwright `page.exposeBinding` / CDP transfer, or fetch `POST /artifact` **from the page** directly to the bot HTTP server (same origin/config as the stream) |

No host ffmpeg required. Seekability of Chrome webm can be poor ([crbug discussion via SO](https://stackoverflow.com/questions/66813248/video-capture-of-canvas-element-by-mediastream-recording-api-is-not-working)); fine for CI failure clips.

### (b) Playwright `recordVideo`

One webm per page, finalized on **context/page close** ([Playwright videos](https://playwright.dev/docs/videos)). Test runner can get per-test files by isolating contexts; a long-lived viewer page shared across suite tests does **not** get clean per-test segments without restarting the page/context. Uses Playwright’s bundled ffmpeg internally. Burnt-in suite/assertion captions are not first-class for our `mark` events (recent `show.actions` annotations are Playwright-action oriented, not our protocol).

### (c) CDP `Page.startScreencast` + external encoder

Emits JPEG frames; needs an encoder to mux webm/mp4 ([Playwright screencast / ffmpeg deep dive](https://dev.to/mutsuntsai/replacing-playwrights-hardcoded-vp8-encoder-a-deep-dive-into-pagescreencast-43ee)). Change-driven; ack latency caps FPS ([SO](https://stackoverflow.com/questions/71437739/page-startscreencast-chrome-devtools-protocol-low-fps-issue)). **Requires ffmpeg (or equivalent) on the host** — fails the “no ffmpeg on host” constraint unless we vendor one.

### Playwright bundled ffmpeg on this machine

Verified present:

`%LOCALAPPDATA%\ms-playwright\ffmpeg-1011\ffmpeg-win64.exe` — reports `n7.0.1-playwright-build-1011`.

Configure is a **stripped** build: `--disable-everything`, then only pipe/file protocols, mjpeg decode, **libvpx VP8** encode/decode, webm/matroska, png, scale/crop/pad. Usable as Playwright’s internal recorder backend; **not** a general ffmpeg. Path is versioned (`ffmpeg-1011`), OS-specific, and owned by `npx playwright install` — fragile as a hard dependency for our harness. **Do not rely on it** for Stage 3 video; treat as Playwright-private.

### Captions

**Burn in by compositing, not by drawing text into the GL scene.**

1. WebGL canvas draws the world.
2. Each frame (or on `mark` change): 2D canvas `drawImage(webglCanvas, 0, 0)` then `fillText` suite/test/elapsed/assertion.
3. `compositeCanvas.captureStream(fps)` → `MediaRecorder`.

Reason: caption layout stays CSS/2D-simple; GL shaders/meshes untouched; failure message updates without a GL text atlas (Stage 11 concern). Drawing text in GL couples capture to fidelity work and fights the “cubes first” plan.

### Recommendation

**Per-test webm via in-page `MediaRecorder` on a 2D composite canvas’s `captureStream`, VP8 (fallback VP9), start/stop on `mark` testStart/testEnd, POST bytes to `/artifact`.** No host ffmpeg. Skip Playwright `recordVideo` for the long-lived viewer page. Skip CDP screencast unless we later accept a vendored encoder.

Cheapest settle experiment: headless Chromium + SwiftShader, animate cubes 2s, `MediaRecorder` VP8, stop, decode length/frames with any webm tool; confirm non-zero duration under software GL.

---

## 4. Golden-image tolerance and SwiftShader speed

### Tolerances people actually use

| Source | Per-pixel | Allowed differing ratio / count |
| --- | --- | --- |
| [Playwright `toHaveScreenshot`](https://playwright.dev/docs/api/class-pageassertions) | `threshold` default **0.2** (YIQ) | `maxDiffPixelRatio` / `maxDiffPixels` unset by default (strict count) |
| [jest-image-snapshot](https://github.com/americanexpress/jest-image-snapshot) | pixelmatch `threshold` default **0.01** | `failureThreshold` default 0; teams often use ~1% on cross-OS font noise ([INTEGU writeup](https://integu.net/jest-image-snapshot-test-setup-for-teamcity-with-diverse-os/)) |
| [rgis CI](https://github.com/rgis-app/rgis/commit/a94e1905e9f70e97e48cd9f440561c3b3ca318c8) | SwiftShader → claim **near-zero** tolerance | GPU path needed **1–3%** `maxDiffPixelRatio` |
| [MVR WebGL guide](https://www.mapvisualregression.org/screenshot-capture-sync-comparison-logic/noise-reduction-for-map-artifacts/reducing-false-positives-from-webgl-rendering-artifacts/) | `threshold: 0` after locking SwiftShader + `antialias: false` | Expect sha256-stable raster fixtures |

**Libraries worth using:** [pixelmatch](https://github.com/mapbox/pixelmatch) (Playwright + jest-image-snapshot), Playwright `toHaveScreenshot` / `toMatchSnapshot`, optional SSIM via jest-image-snapshot `comparisonMethod: 'ssim'`.

**Practical policy for this repo:**

- Generate and compare goldens **only** on CI Chromium + SwiftShader + `antialias: false` + `force-device-scale-factor=1`.
- Defaults: `threshold: 0.1`, `maxDiffPixelRatio: 0.001` (0.1%) — absorbs residual AA/decode noise without hiding a missing cube.
- If same-runner sha256 is stable: tighten to `threshold: 0`, `maxDiffPixelRatio: 0`.
- Do **not** compare local GPU goldens to CI SwiftShader goldens.

### Is software rendering fast enough?

Honest answer: **measure; published numbers are scene-specific.**

Known anchors:

- Microlink: heavy WebGL page **~24s** SwiftShader vs **~6s** Mesa llvmpipe on GPU-less Linux ([Microlink](https://microlink.io/blog/webgl-without-a-gpu)); llvmpipe needs a real GL/X stack and can silently fall back.
- BotBrowser: SwiftShader ~2× CPU of llvmpipe on sustained Canvas/WebGL2 under Xvfb ([llvmpipe vs SwiftShader](https://botbrowser.io/en/blog/mesa-llvmpipe-vs-swiftshader-chromium-linux/)).

No credible public FPS for “few hundred thousand instanced cubes @ 1280×720 on 2-vCPU SwiftShader.” Order-of-magnitude expectation: **low single-digit FPS or worse** for dense instancing; watchable 10–15 fps video of a **sparse** cube world is plausible; full radius terrain mesh is not.

**What to measure (one CI job):**

1. Fixture: N instanced cubes (sweep N = 1e3, 1e4, 1e5), 1280×720, SwiftShader flags, 2-vCPU runner.
2. Log `rAF` intervals for 5s wall; report median FPS and p95 frame time.
3. Record 10 fps MediaRecorder segment; assert file size and duration.

**Fallback ladder:** drop resolution (1280→960→640), drop video fps (15→10→5), shrink stream `radius`, cap visible instances, prefer stills over video when FPS < target. Optional later: try `--use-angle=gl` + llvmpipe on Linux images that ship Mesa — faster but more ops complexity ([Microlink](https://microlink.io/blog/webgl-without-a-gpu)).

---

## 5. Decision (implementation defaults)

| Concern | Choice | One-line reason |
| --- | --- | --- |
| **Stills** | In-page `canvas.toBlob('image/png')` after present of `tick >= minTick`, `preserveDrawingBuffer: true`, `antialias: false`; Playwright Chromium **new headless** + SwiftShader flags in CI | Same JS path as interactive; protocol already POSTs PNG bytes; shell/headless-gl diverge |
| **Video** | `MediaRecorder` + `captureStream` on a **2D composite** canvas (WebGL drawImage + caption text); VP8 webm; segment on `mark` testStart/testEnd | Per-test without host ffmpeg; captions stay out of GL |
| **CI** | Full Chromium new headless; `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --force-device-scale-factor=1`; assert renderer string; goldens from this path only | Deterministic, GPU-less; auto SwiftShader fallback is going away |
| **Resolution** | **1280×720** | Watchable failure clips; 2-vCPU soft-GL budget |
| **Video frame rate** | **10 fps** | Enough for assertion forensics; halves encode/CPU vs 20 |
| **Segment length cap** | **30 s** per test (stop early on `testEnd`) | Bounds artefact size; long tests still get a trailing window if we later add ring-buffer (v1: record whole test up to 30s then hard-stop) |
| **Screenshot timeout** | **5000 ms** (protocol default) | Fail fast via `/capture/<id>/error`, never hang |
| **Golden compare** | pixelmatch via Playwright assert; `threshold: 0.1`, `maxDiffPixelRatio: 0.001`; tighten if CI sha256-stable | Survives tiny soft-GL noise; fails real regressions |

**Do not:** use `chrome-headless-shell` for capture; use `headless-gl` for Stage 3 artefacts; depend on `%LOCALAPPDATA%\ms-playwright\ffmpeg-*`; burn captions into the WebGL scene; accept screenshots with `lastPresentedTick < minTick`.
