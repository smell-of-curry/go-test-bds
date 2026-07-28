package viewer

import "strings"

// protocolChatPrefixes are bot↔addon wire lines that must never appear in a
// recording's chat HUD. Filtered at encode/emit time so a handler that forgot
// to drop them still cannot pollute the stream.
var protocolChatPrefixes = []string{
	"[RUN_ACTION]",
	"[STATUS]",
	"[GOTESTBDS]",
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
