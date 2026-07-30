package viewer

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// actorHealthRe finds the pack health payload after the details pad.
// Live HP: `G0.0⠀100%%`. Fainted: `G0%⠀Fainted`.
var actorHealthRe = regexp.MustCompile(`([GYR]\d+\.\d+|[GYR]0%)`)

var actorLevelRe = regexp.MustCompile(`\n Lv\.\d`)

// normalizeFormButtonText aligns live BEH button encodings with attack.json
// strip lengths (move sep at 36; actor details pad to 58).
//
// Length math matches JS string indices / Bedrock `%.Ns` (UTF-16 code units for
// BMP; § is one unit). Go `len` is bytes — always count runes here.
//
// @param text Flattened / lang-resolved button label.
// @returns text with battle field padding corrected when needed.
func normalizeFormButtonText(text string) string {
	return normalizeBattleActorButton(normalizeBattleMoveButton(text))
}

// normalizeBattleMoveButton inserts the missing sep so `.moveId` lands at
// index 36 (pack strips %.36s before reading the id).
//
// @param text Button label.
// @returns padded move encoding, or unchanged.
func normalizeBattleMoveButton(text string) string {
	runes := []rune(text)
	if len(runes) < 37 || runes[0] != 'b' || runes[1] != ':' {
		return text
	}
	if runes[36] == '.' {
		return text
	}
	if runes[35] == '.' && (runes[34] == '\u00a0' || runes[34] == ' ') {
		out := make([]rune, 0, len(runes)+1)
		out = append(out, runes[:35]...)
		out = append(out, runes[34])
		out = append(out, runes[35:]...)
		return string(out)
	}
	return text
}

// normalizeBattleActorButton pads details to 58 so %.58s excludes health.
// Legacy BEH used padEnd(50) → glued "Lv.5G0.0  10" on the plate subtitle.
//
// @param text Button label.
// @returns actor button with details padded to 58, or unchanged.
func normalizeBattleActorButton(text string) string {
	loc := actorHealthRe.FindStringIndex(text)
	if loc == nil {
		return text
	}
	if !actorLevelRe.MatchString(text) && !strings.Contains(text, "§0§") {
		return text
	}
	healthAt := utf8.RuneCountInString(text[:loc[0]])
	if healthAt == 58 {
		return text
	}
	runes := []rune(text)
	if healthAt > len(runes) {
		return text
	}
	health := string(runes[healthAt:])
	details := strings.TrimRight(string(runes[:healthAt]), "_")
	dRunes := []rune(details)
	if len(dRunes) > 58 {
		dRunes = dRunes[:58]
	}
	for len(dRunes) < 58 {
		dRunes = append(dRunes, '_')
	}
	return string(dRunes) + health
}
