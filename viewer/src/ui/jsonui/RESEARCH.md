# JSON UI research (fixtures + wiring notes)

Sources: `viewer/testdata/jsonui/{vanilla,pokebedrock}/`, BEH `src/pokebedrock/lib/PHUD.ts`, `…/modules/events/sidebar.ts`, `…/modules/models/actors/PlayerActor.ts`, `…/modules/models/BattleUtils.ts`. Paths below are fixture-relative unless noted.

---

## 1. PHUD title routing + centered-title suppression

### Server → title string

BEH `PHUD.ts` `writePhudToken` / `setPhudToken` call `onScreenDisplay.setTitle` with payload `&_<token>:<value>` (or `['&_<token>:', ...parts]`). Tokens: `phone` | `currency` | `loadingScreen` | `sidebar` | `playerPing` | `battleWait` | `evolutionWait`.

Battle log also passes `titleOptions.subtitle` = turn/weather rawtext (`PlayerActor.displayLogForm` → `getBattleSideText()`), which feeds `#hud_subtitle_text_string`.

### RES consume path

| Step | File / JSON path | Binding / expression |
|------|------------------|----------------------|
| Inject PHUD into HUD | `pokebedrock/hud_screen.json` → `root_panel.modifications[0]` | `insert_back` control `phud@phud.main` |
| Per-token latch | `pokebedrock/phud/phud.json` → `data_control` | global `#hud_title_text_string`; on `visibility_changed` copy → `#preserved_text`; visible when title contains `$update_string` |
| Token prefixes | same → `renderers` children | `$update_string`: `&_currency:` / `&_phone:` / `&_battleWait:` / `&_loadingScreen:` / `&_evolutionWait:` / `&_sidebar:` / `&_playerPing:` |
| Strip prefix → props | same → `elements.bindings` | e.g. `(#preserved_text - '&_sidebar:')` → `#sidebar`; battle → `#battleLog`; ping → `#player_ping_text` |
| Widget hosts | same → `elements.controls` | `currency@phud_currency.main`, `phone@phud_phone.main`, `battle_wait@phud_battleWait.main`, `loadingScreen@…`, `evolutionWait@…`, `sidebar@phud_sidebar.main` |
| Ping (chat stack) | `pokebedrock/hud_screen.json` → `root_panel/chat_stack.modifications` | `player_ping@player_ping.main` after `player_position`; reads `#player_ping_text` from `phud.elements` |

### Suppress centered title (live bug fix)

`pokebedrock/hud_screen.json` path-overrides (not a full element replace):

- `hud_title_text/title_frame/title_background` and `…/title`: view binding  
  `source_property_name`: `(not ((%.1s * #hud_title_text_string ) = '&_'))` → `#visible`  
  Intent: hide title chrome when string is a PHUD control token.
- `hud_title_text/subtitle_frame/subtitle`: `"visible": false` (hard kill centered subtitle).

Battle wait still shows turn info via `phud/battle_wait.json` → `info_label` binding `#hud_subtitle_text_string` → `#text` (right red panel). Log text uses `#battleLog` in the left panel.

**UNVERIFIED:** `%.1s` is first **1** char; compared to `'&_'` (2 chars). Strict first-N semantics never equal → `#visible` stays true → centered title leaks (matches viewer bug). Settle with: feed `#hud_title_text_string='&_sidebar:x'` and assert title `#visible` false on real client vs engine. If real client hides, Bedrock coerces differently than wiki `%.Ns`.

**Viewer integration:** `hud.ts` `applyTitleQuirk` force-hides the vanilla title/subtitle subtree when the title matches `/^&_[A-Za-z]+:/`, after pack bindings run. Pack expression path stays intact so a fixed pack can take over.

---

## 2. Sidebar

### Payload (BEH → title)

`pokebedrock-beh/.../modules/events/sidebar.ts` `updateSidebar`:

- 6 party slots × 7 fields (empty = `['null','null','null','false','empty','null','100']`):
  0 stats (`HP: a/b` / `§7Fainted` + `Lv.` + status tag), 1 nickname(+shiny/gender glyphs), 2 species id / `egg` / skin, 3 selected bool string, 4 ball type, 5 `default|dark`/` + typeId` icon path fragment, 6 XP **clip percent** 0–100 (hidden fraction; eggs/empty → `100`).
- Each field `padEnd(120, '|')`, flatten, `join('|')`, then `writePhudToken(player, 'sidebar', …)` → `&_sidebar:<payload>`.

### RES parse

`pokebedrock/_global_variables.json`:

```json
"$string_parser": "((('%.' + $var_size + 's') * (#string - (('%.' + ($var_size * $var_index) + 's') * #string))) - '|')"
```

`phud/sidebar.json` → `main` / `dock`: `$var_size`: **121** (field width 120 + separator). Field index = `$var_index` (0–41). XP bar: `(#field * 1) * $percent_to_ratio` (`0.01`) → `#clip_ratio`, `binding_condition: "always"`, `clip_direction: "left"`.

### Element tree (ONE dock)

```
phud_sidebar.main                    panel  size ["222.22%y", 192]  anchor right_middle
└── dock                             image  textures/ui/sidebar/dock
                                     size ["100%","100%"]  offset ["47%","0%"]  layer 1
                                     $var_size=121
    └── pokemon_holder               stack_panel vertical  size ["100%","100%c"]
        ├── pokemon1@pokemon_sidebar_pokemon   indices 0–6
        ├── pokemon2                           7–13
        ├── … pokemon6                         35–41
```

Per slot `pokemon_sidebar_pokemon` (size `["100%", 32]`):

```
pokemon_data@variable_parser         image textures/ui/sidebar/data  size ["80%", 27]  offset ["-11%","0%"]
                                     $visible: (not(#var = 'null'))   ← plate hidden when empty
└── pokemon_data_stack               stack_panel  offset [0,8]  size ["100%","90%c"]
    ├── name label (idx name)        font 0.7 right
    ├── pad 1px
    ├── stats label (idx stats)      font 0.5 right
    ├── pad 1px
    └── xp_bar_wrapper               size ["100%", 2]
        └── xp bar 62×100%           Black bg + filled_progress_bar clip_ratio
pokemon_icon_wrapper                 ball textures/ui/sidebar/balls/<type>
└── pokemon_icon                     textures/sprites/<icon>  (hidden if 'null')
pokemon_selected_indicator           textures/ui/sidebar/ring when active field truthy
```

**Dock count:** `main.controls` has exactly **one** child `"dock"`. Four docks = engine mistake (duplicating dock or mis-reading `data.png` bevels as extra columns). Visibility of whole sidebar: `(not (#sidebar = ''))`.

---

## 3. Battle UI

### Not chest form for moves

Battle action UI is an **ActionForm** (long_form / `form_buttons` collection), not ChestGUI.

### Title-flag router

`pokebedrock/server_form.json` → `ng_long_form`:

- `$flag_battle`: `"§b§a§t§l§e"`
- Control `pokemon_battle@battle.main` visible when `(not ((#title_text - $flag_battle) = #title_text))`
- Default vanilla `long_form` hidden when any custom flag present

BEH `PlayerActor.chooseActionScreen`:

```ts
new ActionForm(`${'§b§a§t§l§e§s§m'}${'§0§1'}`, { rawtext: this.getBattleSideText() })
```

Title contains flag `§b§a§t§l§e`; body → `#form_text` (turn/timer/weather/terrain).

### Layout file

`pokebedrock/pokemon/attack.json` namespace `battle`:

- `battle.main` → bottom bar `battle_menu` (29% height, red tint) + actor detail stacks
- Left: bag / party / run via `battle_action_button` matching `#form_button_text` contains `battleButton:bag|pokemon|run`
- Center grid: move buttons `b:1_`…`b:4_` (`grid_button` / `move_button`)
- Right: `info_label` `#form_text` (same turn panel as wait UI)

### Move button encoding (BEH → RES)

`BattleUtils.addMoveButton`:

- Button text raw: `b:<1-4>_<type padded30> .<moveId padded30> <pp/max padded30>` + hover desc rawtext
- Icon path: `#form_button_texture` = `t__N` / `f__N` (enabled + PP bar index) via 2nd addButton arg
- RES parses type icon `textures/ui/gui/attacks/<type>`, name lang `showdown.moves.<id>.name`, PP substring, PP bar child by texture suffix

### Wait / log (no form)

`writePhudToken(..., 'battleWait', logLines, { titleOptions: { subtitle: getBattleSideText() } })`  
→ `phud/battle_wait.json`: left `#battleLog`, right `#hud_subtitle_text_string`. Visible when `#battleLog != ''`.

---

## 4. Vanilla HUD (`vanilla/hud_screen.json`, namespace `hud`)

| Feature | Element subtree | Key bindings | Textures |
|---------|-----------------|--------------|----------|
| Hotbar slots | `hotbar_renderer` (custom `hotbar_renderer`) + `hotbar_slot_image`; composed in `hotbar_panel` / `gui_hotbar_slot_button_prototype` | `#hotbar_visible`; collection `$hotbar_collection_name` | caps `textures/ui/hotbar_start_cap`, `hotbar_end_cap`; pocket art `hotbar_0`…`hotbar_8` |
| Selected frame | `hotbar_slot_selected_image` | collection `#slot_selected` → `#visible` | `textures/ui/selected_hotbar_slot` |
| Item icons | `hotbar_hud_item_icon@common.item_renderer` | `$item_collection_name` = hotbar collection | (item renderer, not a static ui texture) |
| Hearts | `heart_renderer` (custom) in `centered_gui_elements*` | `#show_survival_ui` → `#visible` | engine-drawn; helper `heart_image` uses `textures/ui/heart_background` |
| Hunger | `hunger_renderer` | (via parent survival visibility) | engine-drawn |
| Air bubbles | `bubbles_renderer` ×2 | `#is_not_riding_bubbles` / `#is_riding_bubbles` | engine-drawn |
| XP bar | `exp_progress_bar_and_hotbar` → `empty_progress_bar` / `full_progress_bar` / `progress_bar_nub` | `#exp_progress` on full bar | `textures/ui/experiencebarempty`, `experiencebarfull`, `experiencenub` |
| Item name popup | `item_name_text` / `item_name_text_root` | `$text_binding` default `#item_text` | bg `textures/ui/hud_tip_text_background` |

Classic stack: `centered_gui_elements` / `centered_gui_elements_at_bottom_middle` hosts heart/hunger/bubbles + `exp_rend@exp_progress_bar_and_hotbar`.

PokeBedrock replaces `centered_gui_elements_at_bottom_middle` (offsets) and keeps `#hud_visible_centered` → `#visible`.

---

## 5. Server forms (vanilla + PokeBedrock)

### Vanilla ActionForm (long_form)

`vanilla/server_form.json`:

- Screen: `third_party_server_screen` → `$screen_content` = `server_form.main_screen_content`
- Factory: `long_form` → `@server_form.long_form`, `custom_form` → `@server_form.custom_form`
- Title: `long_form` → `$text_name`: `#title_text` via `common_dialogs.standard_title_label`
- Body: `long_form_scrolling_content` → `main_label.text`: `#form_text`
- Buttons: `long_form_dynamic_buttons_panel` collection `form_buttons`; `#form_button_contents` length; each `dynamic_button` → `#form_button_text`, `#form_button_texture`

### Vanilla ModalForm (custom_form)

- `custom_form` → scrolling `custom_form_scrolling_content`
- Factory `generated_contents` collection `custom_form`: label / toggle / slider / dropdown / text_edit
- Submit: `button.submit_custom_form`, `#submit_text`, `#submit_button_visible`

### PokeBedrock override

`pokebedrock/server_form.json` replaces screen content with `ng_main_screen_content` / `ng_long_form` flag router (battle, pokemon, pokedex, chest, search, rotom, pc). Same bindings `#title_text` / `#form_text` / `form_buttons`.

Also fixtures: `chest_server_form.json`, `search_server_form.json` (listed in pb `_ui_defs`).

---

## 6. `_ui_defs` + merge semantics

### Vanilla

`vanilla/_ui_defs.json` → `ui_defs[]` lists ~all stock UI paths including `ui/hud_screen.json`, `ui/server_form.json`, `ui/ui_common.json`, `ui/ui_template_buttons.json`, `ui/gameplay_common.json`. **No** `ui/common.json` in bedrock-samples (404). **No** `_global_variables.json` in `ui_defs`.

### PokeBedrock

`pokebedrock/_ui_defs.json` lists **only new files** (phud/*, pokemon/*, chest/search/rotom). Does **not** list `hud_screen.json` or `server_form.json`.

Those overrides still load if the loader unions paths from **all** packs' defs then fetches each path from every pack that has the file (`load.ts` does this). Vanilla path → pokebedrock file becomes a later `UiFileSource` layer.

### Merge model (matches `types.ts`)

- Same path / namespace: accumulate elements; later pack wins per element name.
- Path keys like `hud_title_text/title_frame/title` = nested control overrides.
- `modifications` arrays (e.g. `root_panel.modifications`) surgically edit vanilla control lists.
- New namespaces (`phud`, `battle`, `phud_sidebar`, …) only from pb files.

### Special: `_global_variables.json`

Present in both packs; **not** referenced by either `_ui_defs.json`. Bedrock loads it as a side channel for `$variables` (pb defines `$string_parser`).

**CONTRADICTION — `load.ts` / `types.ts`:** `loadUiFileSet` only loads `ui_defs` paths. It will **never** load `_global_variables.json` → sidebar `$string_parser` undefined unless loader special-cases that filename. Integration must fetch `ui/_global_variables.json` per pack outside the defs list.

---

## Fixture inventory

### vanilla/ (from Mojang/bedrock-samples `resource_pack/ui/`)

| File | Bytes | Notes |
|------|------:|-------|
| `_ui_defs.json` | 7554 | |
| `_global_variables.json` | 20219 | not in ui_defs |
| `hud_screen.json` | 118510 | |
| `ui_common.json` | 241904 | |
| `server_form.json` | 16550 | |
| `ui_template_buttons.json` | 76484 | |
| `gameplay_common.json` | 28808 | pre-existing; in vanilla ui_defs; not in download request list |
| `common.json` | — | **absent upstream (404)** |

### pokebedrock/ (copied from local RES `ui/`, layout under fixture root = under `ui/`)

Battle/pokemon-related found under RES `ui/`: `pokemon/attack.json` (namespace `battle`), `pokemon/pokemon.json`, `pokemon/pc.json`, `pokemon/pokedex.json`, `phud/battle_wait.json`, plus form routers `server_form.json` / `chest_server_form.json` / `search_server_form.json`. Rotom phone UIs exist in source pack but were **not** copied (not battle HUD); listed in pb `_ui_defs` if needed later.

| File | Bytes |
|------|------:|
| `_ui_defs.json` | 567 |
| `_global_variables.json` | 355 |
| `hud_screen.json` | 3607 |
| `server_form.json` | 15286 |
| `chest_server_form.json` | 29799 |
| `search_server_form.json` | 4579 |
| `phud/phud.json` | 4815 |
| `phud/phone.json` | 3797 |
| `phud/currency.json` | 3594 |
| `phud/battle_wait.json` | 3755 |
| `phud/loadingScreen.json` | 1702 |
| `phud/evolutionWait.json` | 1691 |
| `phud/playerPing.json` | 2405 |
| `phud/sidebar.json` | 14863 |
| `pokemon/attack.json` | 34592 |
| `pokemon/pokemon.json` | 17181 |
| `pokemon/pc.json` | 24969 |
| `pokemon/pokedex.json` | 20383 |

---

## Contract flags vs `types.ts` / `load.ts`

1. **LOUD:** `_global_variables.json` required for sidebar; not in `ui_defs`; current loader skips it.
2. **LOUD (viewer bug):** title suppress uses `(%.1s * #hud_title_text_string) = '&_'`; implement path-key overrides + subtitle `visible:false` or centered battle/title duplication remains.
3. Soft: `types.ts` merge comment OK for element/modifications; confirm path-key (`a/b/c`) overrides are applied in resolver, not only top-level element replace.
4. Soft: hearts/hunger/bubbles are **custom renderers**, not `textures/ui/*` quads — `/asset/` alone cannot draw them without native renderer stubs.
