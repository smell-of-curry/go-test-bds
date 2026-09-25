package viewer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// titleTokenPrefixFromManifest reads bot.titleTokenPrefix from an extensions
// directory manifest.json. A missing file or key returns "" (token splitting
// stays off).
//
// @param dir Extensions directory, or "".
// @returns the configured prefix.
func titleTokenPrefixFromManifest(dir string) string {
	if dir == "" {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return ""
	}
	var doc struct {
		Bot struct {
			TitleTokenPrefix string `json:"titleTokenPrefix"`
		} `json:"bot"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return ""
	}
	return doc.Bot.TitleTokenPrefix
}

// parseTitleToken splits a control token (prefix + name + ":" + value) from a
// flattened title write. An empty prefix disables splitting. Flatten rawtext
// before calling this. Pack-specific rendering belongs in a viewer extension.
//
// @param text Flattened title text.
// @param prefix Token prefix from config (for example "@@"). Empty disables.
// @returns the token name, its raw value, and whether text was a control write.
func parseTitleToken(text, prefix string) (token, value string, ok bool) {
	if prefix == "" {
		return "", "", false
	}
	rest, found := strings.CutPrefix(text, prefix)
	if !found {
		return "", "", false
	}
	token, value, found = strings.Cut(rest, ":")
	if !found {
		return "", "", false
	}
	return token, value, true
}

// filterHudControlText hides title/subtitle/actionbar text that is a control
// token rather than plain visible text. Flatten rawtext before calling this.
// An empty prefix leaves text unchanged.
//
// @param text Flattened title text.
// @param prefix Token prefix from config. Empty disables.
// @returns the visible text, or "" for a control token.
func filterHudControlText(text, prefix string) string {
	if prefix == "" {
		return text
	}
	_, _, ok := parseTitleToken(text, prefix)
	if !ok {
		if strings.HasPrefix(text, prefix) {
			return ""
		}
		if strings.Contains(text, `"`+prefix) {
			return ""
		}
		return text
	}
	return ""
}
