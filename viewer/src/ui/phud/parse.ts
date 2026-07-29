/**
 * Pure parsers for the PokeBedrock PHUD wire formats that ride `&_<token>:`
 * SetTitle writes (delivered on the `phud` SSE lane) and the battle form's
 * encoded buttons. No DOM — unit-tested directly in phudParse.spec.ts.
 *
 * Wire formats (from the behaviour pack feeders):
 * - sidebar  (events/sidebar.ts): 6 slots × 7 fields, every field
 *   `.padEnd(120, '|')` then all joined with `'|'` → field i lives at offset
 *   `i * 121`, width 120, `|`-padded. Fields per slot: stats line, name,
 *   species id, selected flag, ball type, sprite path, XP clip percent
 *   (0–100, the HIDDEN fraction — visible = 100 − clip).
 * - currency (topUiManager.ts): banner message padded to 80 with `'_'`, then
 *   ` <currency>` (currency text usually starts with the coin glyph U+E10E).
 * - battle move buttons (BattleUtils.ts addMoveButton): label starts
 *   `b:<slot>_` + 3 fields each `.padEnd(30, '_')` joined with `' '`
 *   (type, `.`+moveId, `pp/maxpp`), then the display text; the button image
 *   is `t__<bar>` / `f__<bar>` with bar 0–20.
 * - battle tab buttons (PlayerActor.ts): label starts `battleButton:<kind>`
 *   (bag / pokemon / run / move_selection); image `t`/`f`, and for
 *   move_selection `t:_<badge>` (default / mega / mega_disabled).
 */

/** One party slot parsed from the sidebar payload. */
export interface SidebarSlot {
  /** True when the slot has no Pokémon (`species === "null"`). */
  empty: boolean;
  /** Stats line, e.g. `HP: 20/20§r§f Lv. 11` — `???` for an egg. */
  stats: string;
  /** Display name with format codes / gender glyph. */
  name: string;
  /** Species id (`bulbasaur`), `egg`, or a skin id. */
  species: string;
  /** True when this is the selected party slot (ring indicator). */
  selected: boolean;
  /** Ball texture name under `textures/ui/sidebar/balls/` (`empty` when none). */
  ball: string;
  /** Sprite path under `textures/sprites/` (`default/bulbasaur`), or null. */
  sprite: string | null;
  /** XP bar clip percent 0–100 (hidden fraction; visible = 100 − clip). */
  xpClipPercent: number;
}

const SIDEBAR_FIELD_WIDTH = 120;
const SIDEBAR_STRIDE = SIDEBAR_FIELD_WIDTH + 1;
const SIDEBAR_FIELDS_PER_SLOT = 7;
const SIDEBAR_SLOTS = 6;

/**
 * Strip the `|` padding a sidebar field was padded with.
 *
 * @param field - Raw 120-char field.
 * @returns the unpadded value.
 */
function stripSidebarPad(field: string): string {
  let end = field.length;
  while (end > 0 && field[end - 1] === "|") end--;
  return field.slice(0, end);
}

/**
 * Parse the `&_sidebar:` packed payload into six party slots.
 *
 * Positional parse (offset `i * 121`, width 120), matching the RES
 * `sidebar.json` `$var_size: 121` printf indexing — fields may contain
 * anything except being longer than 120 chars.
 *
 * @param value - Token value (after `&_sidebar:`).
 * @returns exactly six slots; missing trailing fields parse as empty slots.
 */
export function parseSidebar(value: string): SidebarSlot[] {
  const field = (i: number): string =>
    stripSidebarPad(
      value.slice(i * SIDEBAR_STRIDE, i * SIDEBAR_STRIDE + SIDEBAR_FIELD_WIDTH),
    );
  const slots: SidebarSlot[] = [];
  for (let s = 0; s < SIDEBAR_SLOTS; s++) {
    const base = s * SIDEBAR_FIELDS_PER_SLOT;
    const species = field(base + 2);
    const clip = Number.parseInt(field(base + 6), 10);
    const sprite = field(base + 5);
    slots.push({
      empty: species === "null" || species === "",
      stats: nullToEmpty(field(base)),
      name: nullToEmpty(field(base + 1)),
      species,
      selected: field(base + 3) === "true",
      ball: field(base + 4) || "empty",
      sprite: sprite === "null" || sprite === "" ? null : sprite,
      xpClipPercent: Number.isFinite(clip)
        ? Math.min(100, Math.max(0, clip))
        : 100,
    });
  }
  return slots;
}

/**
 * @param v - Raw field value.
 * @returns "" for the literal `null` placeholder, the value otherwise.
 */
function nullToEmpty(v: string): string {
  return v === "null" ? "" : v;
}

/** Parsed `&_currency:` payload. */
export interface CurrencyInfo {
  /** Top-center banner / quest / booster message (format codes intact). */
  banner: string;
  /** Currency text, usually starting with the coin glyph U+E10E. */
  currency: string;
}

/**
 * Parse the `&_currency:` payload: 80 `_`-padded banner chars, then the
 * currency text.
 *
 * @param value - Token value (after `&_currency:`).
 * @returns banner and currency halves, trimmed of padding.
 */
export function parseCurrency(value: string): CurrencyInfo {
  const rawBanner = value.slice(0, 80);
  let end = rawBanner.length;
  while (end > 0 && rawBanner[end - 1] === "_") end--;
  return {
    banner: rawBanner.slice(0, end).trim(),
    currency: value.slice(80).trim(),
  };
}

/** A battle move choice parsed from a `b:<slot>_…` button. */
export interface BattleMove {
  /** Original button index on the form (for clicks / hover mapping). */
  index: number;
  /** Move slot 1–4. */
  slot: number;
  /** Lowercase type name (`normal`, `grass`, …) → type icon texture. */
  type: string;
  /** Showdown move id (`growl`). */
  moveId: string;
  /** Current PP. */
  pp: number;
  /** Max PP. */
  maxpp: number;
  /** Display name resolved by the lang layer (first display line). */
  name: string;
  /** Remaining display lines (base power / accuracy / target / description). */
  description: string;
  /** True when the move is disabled (image prefix `f`). */
  disabled: boolean;
  /** PP bar segment 0–20 from the button image, or null when absent. */
  ppBar: number | null;
}

/** A battle tab (bag / pokemon / run) parsed from a `battleButton:` button. */
export interface BattleTab {
  index: number;
  kind: "bag" | "pokemon" | "run";
  /** Resolved label text. */
  label: string;
  disabled: boolean;
}

/** The centre pokeball / mega badge button. */
export interface BattleBall {
  index: number;
  /** Badge texture name (`default`, `mega`, `mega_disabled`). */
  badge: string;
  label: string;
  disabled: boolean;
}

/** Fully decoded battle action form. */
export interface BattleForm {
  moves: BattleMove[];
  tabs: BattleTab[];
  ball: BattleBall | null;
}

const MOVE_PREFIX_RE = /^b:(\d)_(.{30}) (.{30}) (.{30})/;

/**
 * @param s - `_`-padded 30-char encoded field.
 * @returns the value with trailing underscores removed.
 */
function stripUnderscorePad(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "_") end--;
  return s.slice(0, end);
}

/**
 * Whether an open form is the battle action form: its buttons carry the
 * `b:<slot>_` move encoding or the `battleButton:` tab prefix.
 *
 * @param buttons - Form button labels.
 * @returns true when this is a battle form.
 */
export function isBattleForm(buttons: string[] | undefined): boolean {
  if (!buttons) return false;
  return buttons.some(
    (b) => MOVE_PREFIX_RE.test(b) || b.startsWith("battleButton:"),
  );
}

/**
 * Decode one battle move button label + image.
 *
 * @param index - Button index on the form.
 * @param label - Flattened button label (encoded prefix + display text).
 * @param image - Button image data (`t__<bar>` / `f__<bar>`), or "".
 * @returns the decoded move, or null when the label is not a move button.
 */
export function parseBattleMoveButton(
  index: number,
  label: string,
  image: string,
): BattleMove | null {
  const m = MOVE_PREFIX_RE.exec(label);
  if (!m) return null;
  const ppRaw = stripUnderscorePad(m[4]!);
  const [ppStr, maxppStr] = ppRaw.split("/");
  const rest = label.slice(m[0].length);
  const lines = rest.split("\n");
  const barMatch = /^[tf]__(\d+)/.exec(image);
  return {
    index,
    slot: Number.parseInt(m[1]!, 10),
    type: stripUnderscorePad(m[2]!),
    moveId: stripUnderscorePad(m[3]!).replace(/^\./, ""),
    pp: Number.parseInt(ppStr ?? "0", 10) || 0,
    maxpp: Number.parseInt(maxppStr ?? "0", 10) || 0,
    name: (lines[0] ?? "").trim(),
    description: lines.slice(1).join("\n").trim(),
    disabled: image.startsWith("f"),
    ppBar: barMatch ? Number.parseInt(barMatch[1]!, 10) : null,
  };
}

/**
 * Decode the battle action form's buttons into moves, tabs and the centre
 * pokeball badge.
 *
 * @param buttons - Form button labels (lang-resolved).
 * @param images - Parallel button image data (may be shorter / absent).
 * @returns the structured battle form.
 */
export function parseBattleForm(
  buttons: string[],
  images: string[] | undefined,
): BattleForm {
  const out: BattleForm = { moves: [], tabs: [], ball: null };
  for (let i = 0; i < buttons.length; i++) {
    const label = buttons[i]!;
    const image = images?.[i] ?? "";
    const move = parseBattleMoveButton(i, label, image);
    if (move) {
      out.moves.push(move);
      continue;
    }
    if (!label.startsWith("battleButton:")) continue;
    const rest = label.slice("battleButton:".length);
    // Prefix match, longest first: the resolved label text is concatenated
    // straight after the kind (no separator), and with a missing lang table
    // it can itself start with lowercase letters ("bagmodels.player…").
    const kind = ["move_selection", "pokemon", "bag", "run"].find((k) =>
      rest.startsWith(k),
    );
    if (!kind) continue;
    const text = rest.slice(kind.length).trim();
    if (kind === "bag" || kind === "pokemon" || kind === "run") {
      out.tabs.push({
        index: i,
        kind,
        label: text,
        disabled: image.startsWith("f"),
      });
      continue;
    }
    // move_selection: image is `t:_<badge>` / `f:_<badge>`.
    const badge = image.length > 3 ? image.slice(3) : "default";
    out.ball = {
      index: i,
      badge,
      label: text,
      disabled: image.startsWith("f"),
    };
  }
  return out;
}

/** A waypoint target parsed from a `mark` frame with phase `waypoint`. */
export interface Waypoint {
  x: number;
  y: number;
  z: number;
  label: string;
}

/**
 * Parse a waypoint mark message: `x,y,z|label` (label optional).
 *
 * @param message - Mark frame message.
 * @returns the waypoint, or null when the message is not parseable.
 */
export function parseWaypoint(message: string): Waypoint | null {
  const [coords, ...labelParts] = message.split("|");
  const nums = (coords ?? "")
    .split(",")
    .map((n) => Number.parseFloat(n.trim()));
  if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n))) return null;
  return {
    x: nums[0]!,
    y: nums[1]!,
    z: nums[2]!,
    label: labelParts.join("|").trim(),
  };
}

/**
 * Bearing from an observer to a target, relative to the observer's yaw.
 *
 * Bedrock yaw convention: 0° faces +Z, 90° faces −X (increases clockwise
 * viewed from above), so the facing vector is (−sin yaw, cos yaw).
 *
 * @param pos - Observer position `[x, y, z]`.
 * @param yawDeg - Observer yaw in degrees.
 * @param target - Waypoint target.
 * @returns relative bearing in degrees, normalised to (−180, 180]; 0 = dead
 * ahead, positive = clockwise (to the observer's right).
 */
export function relativeBearing(
  pos: [number, number, number],
  yawDeg: number,
  target: Waypoint,
): number {
  const dx = target.x - pos[0];
  const dz = target.z - pos[2];
  // World bearing of the target with the same convention as yaw.
  const bearing = (Math.atan2(-dx, dz) * 180) / Math.PI;
  let rel = bearing - yawDeg;
  while (rel <= -180) rel += 360;
  while (rel > 180) rel -= 360;
  return rel;
}

/**
 * 3D distance between an observer and a waypoint, rounded for display.
 *
 * @param pos - Observer position `[x, y, z]`.
 * @param target - Waypoint target.
 * @returns whole-block distance.
 */
export function waypointDistance(
  pos: [number, number, number],
  target: Waypoint,
): number {
  const dx = target.x - pos[0];
  const dy = target.y - pos[1];
  const dz = target.z - pos[2];
  return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
}
