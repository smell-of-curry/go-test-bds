# UILabHelper

Headless macOS helper that screenshots and drives a real Minecraft Bedrock client (`mcpelauncher-client`). It is its own `.app` so Screen Recording and Accessibility attach to this bundle, not to the shell that calls it.

## Build

```bash
bash build.sh
```

Produces `build/UILabHelper.app` (ad-hoc signed). Each rebuild changes the signature, so macOS may ask for Screen Recording again.

## Launch and permissions

```bash
open build/UILabHelper.app
```

Use `open` on the bundle. Running the Mach-O directly ties TCC to a different process.

In System Settings → Privacy & Security grant **Screen Recording** and **Accessibility** for UILabHelper, then relaunch:

```bash
pkill -f UILabHelper
open build/UILabHelper.app
```

The process is an `LSUIElement` (no Dock icon). It listens on `127.0.0.1:47800`.

## Endpoints

- `GET /health` → `{"ok":true,"screen":<bool>,"ax":<bool>}`
- `GET /request-permissions` → prompts for Screen Recording and Accessibility, then the same JSON as `/health`
- `GET /windows` → on-screen windows `{id, app, bundleId, pid, title, x, y, w, h}`
- `GET /capture?app=mcpelauncher[&window=<id>]&out=/abs/path.png[&scale=native|1]` → PNG of the largest matching window. `scale` defaults to `native` (points × backing scale). Failures are HTTP 500 `{"error":"..."}`.
- `POST /input` with window-relative points (origin top-left of the matched window, y down):

```bash
curl -s -X POST 127.0.0.1:47800/input \
  -d '{"app":"mcpelauncher","actions":[{"type":"activate"},{"type":"key","key":"t"},{"type":"text","text":"/say hi"},{"type":"wait","ms":200},{"type":"key","key":"enter"}]}'
```

Action `type`: `move`, `click` (`button` `left` or `right`), `key` (`escape`, `enter`, `tab`, `f1`, `slash`, or a single US-ANSI character), `text`, `wait`, `activate`.

## Coordinates

`SCWindow.frame` and `CGEvent` locations are Quartz global points: origin at the top-left of the primary display, y down. Input `x`/`y` are added to that frame. Key events use US ANSI virtual keycodes (`kVK_*`). `text` sends Unicode per character.
