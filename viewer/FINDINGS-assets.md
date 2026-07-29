# Findings — assets and pack stack (stage 5)

## Pack stack precedence

Evidence, not assumption:

1. `packet.ResourcePackStack` (`gophertunnel`): "The order of these texture
   packs specifies the order that they are applied in on the client side. The
   first in the list will be applied first."
2. `packet.ResourcePacksInfo`: "The order of these texture packs is not
   relevant in this packet. It is however important in the ResourcePackStack
   packet."
3. Fixture `gotestbds/assets/testdata` + `TestStackServerPackWins`: vanilla
   then server; `textures/blocks/stone.png` resolves to the server pack.

Vanilla is always priority 0 (lowest). Later stack entries win on path
collision.

## Subpack selection

Microsoft Learn — Building Sub-Packs:

- Prefer `memory_performance_tier` (1–5) when set; else `memory_tier`.
- Pick the highest tier that does not exceed the device tier.
- On a tie, the last matching subpack in the manifest array wins.
- Wire `StackResourcePack.SubPackName` forces that folder when present.

Locked by `TestSubpackMemoryPerformanceTier` (tier 1 → `lite`) and
`TestStackServerPackWins` (tier 5 → `full`).

## What `bedrock-samples` does not ship

| Gap | Impact | What the viewer does |
| --- | --- | --- |
| `materials/` | no `material.default` definitions | **Answered (Stage 7):** name→state table in `entity/material.ts` + `entity/README.md` (alpha_test / blend / opaque, cull, emissive) + RC tint lerp. Terrain still uses `terrain/material.ts`. Optional install overlay remains an escape hatch. |
| shaders | no client shader sources | Not needed. Gradient sky dome + `THREE.Fog` (Stage 10b); lighting is vertex-baked into `vertColor`, not a Bedrock shader port. |
| font glyph atlas | no bitmap font pages | Stage 7 name tags = canvas + `Courier New` + `§` colours; Stage 11 HUD/forms stay DOM. JSON UI + real glyph pages stay a fidelity track. |

## `metadata/vanilladata_modules`

`mojang-blocks.json` is the complete vanilla block+state list (`data_items[].name`
are namespaced ids). `npm run diagnose:terrain` loads it from
`<baseline>/metadata/vanilladata_modules/` (sibling of `resource_pack/`) and
labels each unresolved `blocks.json` id as `vanilla_baseline_gap` vs
`custom_server_pack_gap` in the report's `gaps` object.

## Bump automation

Pin lives in `viewer/baseline.tag` (git tag form, e.g. `v1.26.30.5`).

Mojang's `https://raw.githubusercontent.com/Mojang/bedrock-samples/main/version.json`
maps `"latest"` → `{ "version": "1.26.30.5", "date": "…" }` (no leading `v`).
Release tags are `v` + that version. Preview tags (`v*-preview`) are ignored;
only `latest` is considered.

Workflow `.github/workflows/baseline-bump.yml` (weekly cron + `workflow_dispatch`):

1. Read current pin from `viewer/baseline.tag`.
2. Fetch `version.json`; compute `next = "v" + latest.version`.
3. If changed, open a PR via `peter-evans/create-pull-request` that only updates
   the pin.

### Bump → golden review loop

1. The bump PR touches `viewer/baseline.tag` → `viewer-golden.yml` path filter
   `viewer/**` runs the golden job.
2. That job runs `go run ./cmd/fetch-baseline .cache`, sets
   `GOLDEN_BASELINE_DIR`, and paints real Mojang textures into the golden
   fixture pack (`viewer/tests/goldenApp.ts` — also auto-detects
   `.cache/baseline/<pin>` locally; `GOLDEN_USE_BASELINE=0` forces fixtures).
3. Review image diffs in the job / `viewer-golden-results` artefact.
4. Accept intentional changes: **Viewer golden** `workflow_dispatch` with
   `golden_update=true` (sets `GOLDEN_UPDATE=1`), download
   `viewer-goldens-updated`, commit `viewer/testdata/goldens/*.png`. Prefer CI
   SwiftShader renders; locally `GOLDEN_SOFT=1` inspects without failing.
