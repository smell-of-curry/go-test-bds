# Native emote dataset

The viewer plays locally imported Bedrock animation JSON. It no longer ships a
hand-authored imitation of Wave. Packet UUIDs resolve through each native
`persona_emote` metadata document's `piece_id` and `animation_sources` binding.
Original channels/keyframes are retained; duration comes from the animation,
including its last keyframe when `animation_length` is omitted.

## Import and build

From `viewer/`:

```sh
python3 tools/import-emotes.py
npm run build
```

On this Mac the importer discovers the newest installed mcpelauncher persona
resource pack. Elsewhere pass `--persona /path/to/resource_packs/persona` and
optionally `--persona-cache /path/to/premium_cache/persona`. Supported inputs are
version-1 `.brarchive`, loose metadata/JSON pairs, and readable cache ZIPs. No
files in the client installation are modified. Encrypted/non-JSON metadata is
inventoried, not decrypted or presented as a playable animation. Multiple-source
bindings are flagged as unsupported rather than selecting an arbitrary motion.

Outputs, all ignored by Git:

- `viewer/.cache/emotes/runtime.json`: playable animation documents, UUID/name
  bindings, source paths and SHA-256 provenance.
- `viewer/.cache/emotes/catalog.json`: package inventory, unavailable statuses,
  and optional online metadata.
- Vite embeds only playable IDs, binding names and animation documents in the
  local build. Source paths stay out of the browser bundle. Copying that build
  to a private film machine also carries its imported motion data.

Without an imported dataset, a build warns and emotes contribute no poses.
There is no synthetic fallback. Re-import and rebuild after installing new
readable emotes. Keep the generated assets out of source control and public
redistribution; only importer/runtime code belongs in this repository.

## Online catalog (names and IDs, not motion)

The community [Bedrock-Persona catalog](https://github.com/Daniel-Ric/Bedrock-Persona/tree/main/data/persona_emote)
provides broader discovery metadata. To include a snapshot:

```sh
curl -fsSL https://raw.githubusercontent.com/Daniel-Ric/Bedrock-Persona/main/data/persona_emote/items.json -o /tmp/persona-emote-items.json
python3 tools/import-emotes.py --catalog /tmp/persona-emote-items.json
```

The catalog's listing ID and piece UUID are preserved as separate fields.
Entries without locally resolved motion remain `metadata_only`. An online
listing is not evidence that the animation files are available. The importer
records the snapshot SHA-256 and source; completeness of this community mirror
is not guaranteed.

## Verified local coverage, 2026-11-06

Minecraft 1.26.60.4 supplies four readable bundled emotes:

- Wave (`overhead_wave`), 2.133333 seconds.
- Simple Clap (`basic_clap`), 2.2 seconds.
- Follow Me (`communication_follow_me`), 1.633333 seconds.
- Point / Over There (`communication_point`), 1.333333 seconds.

The scan inventoried 150 local packages/fragments, including 71 cached persona
packages with unreadable metadata. These are not claimed to be 71 emotes; persona
packages also contain clothing and other pieces. The online snapshot contained
2,171 listings, stored as metadata only unless matched to readable local motion.

## Verification and current rendering limit

```sh
python3 -m unittest discover -s tools -p test_import_emotes.py
node --import tsx --test src/entity/emotes/emotes.test.ts
node tools/preview-emotes.mjs /path/to/vanilla/resource_pack
```

The preview renders five times per emote and writes `.cache/emotes/preview.png`
and `preview.json`, including any animation bones absent from the player rig.
The native wave test runs when the local dataset exists; CI can run the synthetic
parser fixture without distributing game assets. Every imported pose is checked
for finite values throughout its duration.

All four animations contain a `hip` channel absent from both the baseline custom
player geometry and the installed medium persona skeleton. That channel is
preserved in the dataset but currently contributes no rendered transform. No
speculative hip-to-waist remapping has been added. Native-client comparison is
still needed to establish Bedrock's retargeting behavior and exact visual parity.
The existing exported promo is not changed by this import/build alone.

Archive layout reference:
[brarchive-extractor format documentation](https://github.com/LPaicen/brarchive-extractor/blob/main/docs/brarchive-format.md).
