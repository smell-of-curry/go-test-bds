package viewer

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// protocolChatPrefixes are bot↔addon wire lines that must never appear in a
// recording's chat HUD. Filtered at encode/emit time so a handler that forgot
// to drop them still cannot pollute the stream.
var protocolChatPrefixes = []string{
	"[RUN_ACTION]",
	"[STATUS]",
	"[GOTESTBDS]",
	// Proxy↔addon handshakes ([PROXY_XUID], [PROXY_PING], [PROXY_SYSTEM], …)
	// ride the chat channel too; a proxy strips them before real clients, but
	// the bot connects to BDS directly and sees them raw.
	"[PROXY_",
}

// protocolChatPatterns catch non-prefixed test/protocol chat that still must
// stay out of recordings (SDK e2e round-trip pings, bare ping-<epochMs>).
var protocolChatPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)^e2e-ping-`),
	regexp.MustCompile(`(?i)^ping-\d+$`),
}

// isProtocolChatNoise reports whether text is an internal bot protocol line.
//
// @param text Raw chat/system message text.
// @returns true when the line must be excluded from the viewer stream.
func isProtocolChatNoise(text string) bool {
	trimmed := strings.TrimSpace(text)
	for _, p := range protocolChatPrefixes {
		if strings.HasPrefix(trimmed, p) {
			return true
		}
	}
	plain := stripSectionSigns(trimmed)
	for _, re := range protocolChatPatterns {
		if re.MatchString(plain) {
			return true
		}
	}
	return false
}

// stripSectionSigns drops Bedrock § formatting codes so pattern matches see
// the plain payload ("§eping-1" → "ping-1").
//
// @param text Possibly formatted chat text.
// @returns text with §X pairs removed.
func stripSectionSigns(text string) string {
	if !strings.ContainsRune(text, '§') {
		return text
	}
	runes := []rune(text)
	var b strings.Builder
	b.Grow(len(runes))
	for i := 0; i < len(runes); i++ {
		if runes[i] == '§' {
			if i+1 < len(runes) {
				i++
			}
			continue
		}
		b.WriteRune(runes[i])
	}
	return b.String()
}

// rawtextPart is one element of a Bedrock rawtext message.
type rawtextPart struct {
	Text      string          `json:"text"`
	Translate string          `json:"translate"`
	With      json.RawMessage `json:"with"`
}

// rawtextMessage is the {"rawtext":[…]} envelope addons send through
// sendMessage/SetTitle.
type rawtextMessage struct {
	RawText []rawtextPart `json:"rawtext"`
}

// flattenRawtext renders Bedrock rawtext JSON as readable text: "text" parts
// verbatim, "translate" parts through the pack-stack lang table when one is
// installed (falling back to the key with "with" substitution args appended
// space-separated). Anything that is not a rawtext envelope passes through
// untouched.
// Without this, a title like the battle sidebar renders as a wall of JSON in
// the recording.
//
// The envelope is located anywhere in the string, not just at the start —
// titles arrive with formatting codes or label text glued in front of the
// JSON, and a prefix-only check leaves those unflattened (run 14's finale
// subtitle).
//
// @param text Raw title/chat text from the wire.
// @returns text with any embedded rawtext envelope flattened, or unchanged.
func flattenRawtext(text string) string {
	idx := strings.Index(text, `{"rawtext"`)
	if idx < 0 {
		// Bare `{"translate":…}` (no rawtext wrapper) — keep for lang resolve.
		trimmed := strings.TrimSpace(text)
		if strings.HasPrefix(trimmed, `{"translate"`) {
			var part rawtextPart
			if json.Unmarshal([]byte(trimmed), &part) == nil && part.Translate != "" {
				args := rawtextWithArgs(part.With)
				if resolved, ok := translateKey(part.Translate, args); ok {
					return resolved
				}
				return part.Translate
			}
		}
		return text
	}
	dec := json.NewDecoder(strings.NewReader(text[idx:]))
	var msg rawtextMessage
	if dec.Decode(&msg) != nil || len(msg.RawText) == 0 {
		return text
	}
	var b strings.Builder
	b.WriteString(text[:idx])
	for _, part := range msg.RawText {
		b.WriteString(part.Text)
		if part.Translate == "" {
			continue
		}
		args := rawtextWithArgs(part.With)
		// A pack-stack lang table renders the key the way a client would;
		// without one the key itself plus space-joined args stays readable.
		if resolved, ok := translateKey(part.Translate, args); ok {
			b.WriteString(resolved)
			continue
		}
		b.WriteString(part.Translate)
		for _, arg := range args {
			if arg == "" {
				continue
			}
			b.WriteString(" ")
			b.WriteString(arg)
		}
	}
	b.WriteString(text[idx+int(dec.InputOffset()):])
	return b.String()
}

// rawtextWithArgs extracts substitution arguments from a rawtext "with"
// field, which the protocol allows as either a plain array (strings, but
// numbers happen in the wild) or a nested rawtext object whose parts may
// themselves be translate keys — those resolve through the lang table.
//
// @param raw The raw JSON of the "with" field, possibly empty.
// @returns The argument strings, or nil when there are none.
func rawtextWithArgs(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var plain []any
	if json.Unmarshal(raw, &plain) == nil {
		args := make([]string, 0, len(plain))
		for _, v := range plain {
			switch t := v.(type) {
			case string:
				args = append(args, t)
			case float64:
				args = append(args, strconv.FormatFloat(t, 'f', -1, 64))
			case bool:
				args = append(args, strconv.FormatBool(t))
			default:
				args = append(args, "")
			}
		}
		return args
	}
	var nested rawtextMessage
	if json.Unmarshal(raw, &nested) != nil {
		return nil
	}
	args := make([]string, 0, len(nested.RawText))
	for _, p := range nested.RawText {
		if p.Translate != "" {
			if resolved, ok := translateKey(p.Translate, rawtextWithArgs(p.With)); ok {
				args = append(args, p.Text+resolved)
				continue
			}
		}
		args = append(args, p.Text+p.Translate)
	}
	return args
}

// hudTokenValueShown lists PHUD tokens whose value is real display text a
// real client would show through its JSON UI (the battle log, the tutorial
// objective, the completion card). The viewer has no JSON UI, so it shows the
// value as plain title text. Tokens absent here carry animation/layout state
// (phone poses, packed sidebar data, ping colors) and are dropped.
var hudTokenValueShown = map[string]bool{
	"loadingScreen": true,
	"battleWait":    true,
	"evolutionWait": true,
	"currency":      true,
}

// parsePhudToken splits a PHUD control token ("&_token:value", PokeBedrock's
// SetTitle smuggling convention) into its token name and raw value. Flatten
// rawtext BEFORE calling this — the rawtext form
// ({"rawtext":[{"text":"&_battleWait:"},…]}) only exposes its token once
// flattened.
//
// @param text Flattened title text from the wire.
// @returns the token name, its raw value, and whether text was a PHUD write.
func parsePhudToken(text string) (token, value string, ok bool) {
	rest, found := strings.CutPrefix(text, "&_")
	if !found {
		return "", "", false
	}
	token, value, found = strings.Cut(rest, ":")
	if !found {
		return "", "", false
	}
	return token, value, true
}

// filterHudControlText resolves title/subtitle/actionbar text that is a PHUD
// control token rather than plain visible text: display-worthy token values
// pass through, control-state tokens become "". Flatten rawtext BEFORE calling
// this (see parsePhudToken).
//
// @param text Flattened title text from the wire.
// @returns The visible text for the HUD, or "" for control state.
func filterHudControlText(text string) string {
	token, value, ok := parsePhudToken(text)
	if !ok {
		if strings.HasPrefix(text, "&_") {
			// Token without a value separator carries nothing to show.
			return ""
		}
		// Unflattened rawtext-form tokens must never reach the screen raw.
		if strings.Contains(text, `"&_`) {
			return ""
		}
		return text
	}
	if hudTokenValueShown[token] {
		return value
	}
	return ""
}
