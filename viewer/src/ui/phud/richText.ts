/**
 * Format-code text rendering with Bedrock private-use glyph support.
 *
 * Bedrock maps private-use codepoints U+E000–U+F8FF onto 16×16-cell glyph
 * sheets: U+XXYZ renders cell (row Y, col Z) of `font/glyph_XX.png`. The
 * PokeBedrock pack uses these for the coin (U+E10E), gender marks
 * (U+E108/U+E109) and the shiny star (U+E10A). A browser font renders them
 * as tofu, so they become inline background-image spans served over /asset.
 */
import { parseFormatCodes } from "../formatCodes";

/**
 * Render format-coded text into DOM spans, expanding private-use glyphs into
 * glyph-sheet sprites.
 *
 * @param input - Text that may contain `§` codes and PUA glyphs.
 * @param assetBase - Origin serving `/asset/…` pack files ("" disables glyph
 * images; PUA chars are dropped instead of showing tofu).
 * @returns a fragment ready to append.
 */
export function richTextFragment(
  input: string,
  assetBase: string,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const seg of parseFormatCodes(input)) {
    if (!seg.text) continue;
    let buf = "";
    const flush = (): void => {
      if (!buf) return;
      const span = document.createElement("span");
      if (seg.color) span.style.color = seg.color;
      if (seg.bold) span.style.fontWeight = "700";
      if (seg.italic) span.style.fontStyle = "italic";
      span.textContent = buf;
      frag.appendChild(span);
      buf = "";
    };
    for (const ch of seg.text) {
      const cp = ch.codePointAt(0)!;
      if (cp >= 0xe000 && cp <= 0xf8ff) {
        flush();
        if (assetBase) frag.appendChild(glyphSpan(cp, assetBase));
        continue;
      }
      buf += ch;
    }
    flush();
  }
  return frag;
}

/**
 * Build one glyph-sheet sprite span.
 *
 * @param cp - Private-use codepoint.
 * @param assetBase - Origin serving /asset.
 * @returns an inline-block span showing the glyph cell.
 */
function glyphSpan(cp: number, assetBase: string): HTMLElement {
  const sheet = ((cp >> 8) & 0xff).toString(16).toUpperCase().padStart(2, "0");
  const col = cp & 0xf;
  const row = (cp >> 4) & 0xf;
  const span = document.createElement("span");
  span.className = "jh-glyph";
  span.style.backgroundImage = `url("${assetBase}/asset/font/glyph_${sheet}.png")`;
  // 16×16 grid: size the sheet to 1600% and offset by cell.
  span.style.backgroundSize = "1600% 1600%";
  span.style.backgroundPosition = `${(col / 15) * 100}% ${(row / 15) * 100}%`;
  return span;
}
