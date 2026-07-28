package viewer

import "strings"

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

// filterHudControlText blanks title/subtitle/actionbar text that is a JSON-UI
// control token rather than visible text. Resource packs (PokeBedrock's PHUD
// convention) smuggle UI state through SetTitle as "&_token:value" strings; a
// real client's JSON UI intercepts them, so they are never drawn as titles.
//
// @param text Raw title text from the wire.
// @returns text unchanged, or "" for control tokens.
func filterHudControlText(text string) string {
	// Plain-string form, and the rawtext-JSON form whose first part is the
	// token ({"rawtext":[{"text":"&_currency:"},…]}).
	if strings.HasPrefix(text, "&_") || strings.Contains(text, `"&_`) {
		return ""
	}
	return text
}
