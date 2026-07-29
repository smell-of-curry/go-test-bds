package viewer

import (
	"encoding/json"
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
	return false
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
// verbatim, "translate" parts as their key (the bot has no .lang table to
// resolve them), and "with" substitution args appended space-separated after
// their key. Anything that is not a rawtext envelope passes through untouched.
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
		b.WriteString(part.Translate)
		for _, arg := range rawtextWithArgs(part.With) {
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
// field, which the protocol allows as either a plain string array or a nested
// rawtext object.
//
// @param raw The raw JSON of the "with" field, possibly empty.
// @returns The argument strings, or nil when there are none.
func rawtextWithArgs(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var plain []string
	if json.Unmarshal(raw, &plain) == nil {
		return plain
	}
	var nested rawtextMessage
	if json.Unmarshal(raw, &nested) != nil {
		return nil
	}
	args := make([]string, 0, len(nested.RawText))
	for _, p := range nested.RawText {
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

// filterHudControlText resolves title/subtitle/actionbar text that is a PHUD
// control token ("&_token:value", PokeBedrock's SetTitle smuggling convention)
// rather than plain visible text: display-worthy token values pass through,
// control-state tokens become "". Flatten rawtext BEFORE calling this — the
// rawtext form ({"rawtext":[{"text":"&_battleWait:"},…]}) only exposes its
// token once flattened.
//
// @param text Flattened title text from the wire.
// @returns The visible text for the HUD, or "" for control state.
func filterHudControlText(text string) string {
	if !strings.HasPrefix(text, "&_") {
		// Unflattened rawtext-form tokens must never reach the screen raw.
		if strings.Contains(text, `"&_`) {
			return ""
		}
		return text
	}
	rest := text[2:]
	i := strings.Index(rest, ":")
	if i < 0 {
		return ""
	}
	if hudTokenValueShown[rest[:i]] {
		return rest[i+1:]
	}
	return ""
}
