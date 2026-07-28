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

Still open for stage 6+:

| Gap | Impact | Planned answer |
| --- | --- | --- |
| `materials/` | no `material.default` definitions | empirical mapping; optional install overlay |
| shaders | no client shader sources | not required for software/WebGL placeholder path |
| font glyph atlas | no bitmap font pages | stage 11 owns text rendering |

## Bump automation

Pin lives in `viewer/baseline.tag`. Mojang's `version.json` maps `latest` →
current version. Scheduled PR workflow to bump the pin is not implemented yet
(stage 5 remainder).
