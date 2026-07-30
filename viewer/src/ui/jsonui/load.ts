/**
 * JSON UI loader: pull ui/*.json from every pack in the stack and parse into
 * {@link UiFileSource} layers. Same-named files merge across packs (later wins
 * at the element level) — callers must fetch per-pack, not via `/asset`.
 */

import type { UiFileSource, UiRawFile, PropertyBag } from "./types";

/** Minimal pack descriptor (matches GET /packs fields we need). */
export interface UiPackInfo {
  id: string;
  priority?: number;
}

/**
 * Injectable network surface for {@link loadUiFileSet}.
 * {@link AssetClient} already satisfies this.
 */
export interface UiLoadClient {
  getPacks(): Promise<UiPackInfo[]>;
  fetchPackJson<T = unknown>(packId: string, path: string): Promise<T | null>;
  /**
   * Fetch a non-JSON pack file as UTF-8 text (e.g. `texts/en_US.lang`).
   * Missing → null (404).
   *
   * @param packId - Pack id from GET /packs.
   * @param path - Pack-relative path.
   * @returns file text, or null when absent.
   */
  fetchPackText(packId: string, path: string): Promise<string | null>;
}

interface UiDefsFile {
  ui_defs?: unknown;
}

/** Result of {@link loadUiFileSet}: ui file layers + merged pack globals. */
export interface UiFileSet {
  /** Ui file sources in pack-stack order (lowest first). */
  files: UiFileSource[];
  /**
   * Merged `ui/_global_variables.json` across packs (later pack wins per key).
   * Keys are `$name` strings.
   */
  globals: PropertyBag;
  /**
   * Merged `texts/en_US.lang` across packs (later pack wins per key).
   * Used when a label has `localize: true`.
   */
  lang: Record<string, string>;
}

/**
 * Load every ui file referenced by any pack's `ui/_ui_defs.json`, plus the
 * side-channel `ui/_global_variables.json` and `texts/en_US.lang` from every
 * pack (not listed in defs). Later packs may add ui paths; each path is
 * fetched from every pack that has it. Sources are emitted lowest-priority
 * pack first. Lang keys merge the same way (later pack wins).
 *
 * @param client - Pack list + per-pack JSON/text fetch (injectable for tests).
 * @returns file layers + merged globals map + merged lang table.
 */
export async function loadUiFileSet(client: UiLoadClient): Promise<UiFileSet> {
  const packs = (await client.getPacks()).slice().sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    return pa - pb;
  });

  const paths: string[] = [];
  const seen = new Set<string>();
  const globals: PropertyBag = {};
  const lang: Record<string, string> = {};

  for (const pack of packs) {
    const globalDoc = await client.fetchPackJson<unknown>(
      pack.id,
      "ui/_global_variables.json",
    );
    mergeGlobalVariables(globals, globalDoc);

    const langText = await client.fetchPackText(pack.id, "texts/en_US.lang");
    if (langText != null) Object.assign(lang, parseLangFile(langText));

    const defs = await client.fetchPackJson<UiDefsFile>(
      pack.id,
      "ui/_ui_defs.json",
    );
    if (!defs || !Array.isArray(defs.ui_defs)) continue;
    for (const entry of defs.ui_defs) {
      if (typeof entry !== "string" || !entry) continue;
      const path = normalizeUiPath(entry);
      if (seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }

  const files: UiFileSource[] = [];
  for (const pack of packs) {
    for (const path of paths) {
      const doc = await client.fetchPackJson<unknown>(pack.id, path);
      if (doc == null) continue;
      const raw = parseUiRawFile(doc);
      if (!raw) continue;
      files.push({ packId: pack.id, path, raw });
    }
  }
  return { files, globals, lang };
}

/**
 * Parse a Bedrock `texts/<locale>.lang` file into a key→value map.
 *
 * Format: `key=value` per line; `#` / `##` full-line comments; trailing
 * comment after a tab is stripped; CRLF tolerated. Values keep interior and
 * trailing spaces (lang entries like `Current Ping: ` rely on that).
 *
 * @param text - Raw `.lang` file contents.
 * @returns flat translation table.
 */
export function parseLangFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith("#")) continue;
    const eq = rawLine.indexOf("=");
    if (eq <= 0) continue;
    const key = rawLine.slice(0, eq).trim();
    if (!key) continue;
    let value = rawLine.slice(eq + 1);
    const tab = value.indexOf("\t");
    if (tab >= 0) value = value.slice(0, tab);
    out[key] = value;
  }
  return out;
}

/**
 * Look up a label's text in a lang table when `localize` is truthy.
 * Misses leave the text unchanged (raw key stays visible — useful for
 * spotting missing translations).
 *
 * @param text - Label text (often a lang key).
 * @param localize - Element `localize` prop.
 * @param lang - Merged pack lang table.
 * @returns translated text, or the original when not localizing / miss.
 */
export function localizeLabelText(
  text: string,
  localize: unknown,
  lang: Readonly<Record<string, string>> | undefined,
): string {
  if (localize !== true || !lang || !text) return text;
  return lang[text] ?? text;
}

/**
 * Merge `$…` keys from a `_global_variables.json` document into `into`
 * (later values overwrite). Missing/invalid docs are no-ops.
 *
 * @param into - Accumulator globals map.
 * @param doc - Parsed JSON object, or null/undefined.
 */
export function mergeGlobalVariables(into: PropertyBag, doc: unknown): void {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return;
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    if (!key.startsWith("$")) continue;
    into[key] = value;
  }
}

/**
 * Parse a Bedrock JSON UI document into {@link UiRawFile}.
 *
 * @param doc - Parsed JSON object.
 * @returns raw file, or null when namespace is missing/invalid.
 */
export function parseUiRawFile(doc: unknown): UiRawFile | null {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const obj = doc as Record<string, unknown>;
  if (typeof obj.namespace !== "string" || !obj.namespace) return null;
  const elements: Record<string, PropertyBag> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "namespace") continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    elements[key] = value as PropertyBag;
  }
  return { namespace: obj.namespace, elements };
}

/**
 * Tolerant JSON parse for Bedrock UI files: BOM, `//` / block comments,
 * trailing commas.
 *
 * @param text - Raw file text.
 * @param path - Optional path for error messages.
 * @returns parsed value.
 * @throws when text is not JSON even after cleanup.
 */
export function parseLooseJson<T = unknown>(text: string, path = ""): T {
  let s = text;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  try {
    return JSON.parse(s) as T;
  } catch {
    const stripped = stripJsonComments(s).replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(stripped) as T;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${path || "json"}: ${reason}`);
    }
  }
}

/**
 * @param path - Pack-relative path from ui_defs.
 * @returns lower-cased POSIX path.
 */
function normalizeUiPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

/**
 * Remove `//` and block comments while leaving string contents intact.
 *
 * @param text - Raw file text.
 * @returns text with comments removed.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}
