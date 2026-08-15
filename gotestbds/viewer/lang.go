package viewer

import (
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/assets"
)

// The pack stack ships texts/en_US.lang with every translate key the addon
// uses (battle narration, form buttons, move names). A real client resolves
// those keys before drawing; without this table the recording shows
// "models.showdown.switch.actor" where a player saw "TestBot sent out …".
// Merged per key in stack priority order — later packs win, same as assets.

var activeLang atomic.Pointer[map[string]string]

// installLangTable builds and installs the translate table from a pack
// stack. A nil stack or a stack without lang files installs nothing (keys
// pass through unresolved, the pre-table behaviour).
//
// @param st The merged pack stack, or nil.
func installLangTable(st *assets.Stack) {
	if st == nil {
		return
	}
	table := make(map[string]string)
	for _, p := range st.Packs() { // Packs() is priority-ascending.
		data, _, err := st.PackFile(p.ID, "texts/en_US.lang")
		if err != nil || len(data) == 0 {
			continue
		}
		parseLang(data, table)
	}
	if len(table) == 0 {
		return
	}
	activeLang.Store(&table)
}

// parseLang folds one Bedrock .lang file into a key→template map.
// Format: `key=value` lines, `##` comment lines, CRLF tolerated. A trailing
// tab-then-`##` inline comment is stripped, which is the documented form.
//
// @param data Raw .lang bytes.
// @param into Destination map; existing keys are overwritten (later wins).
func parseLang(data []byte, into map[string]string) {
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSuffix(line, "\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "##") {
			continue
		}
		eq := strings.Index(line, "=")
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := line[eq+1:]
		if i := strings.Index(val, "\t##"); i >= 0 {
			val = val[:i]
		}
		into[key] = val
	}
}

// translateKey resolves one translate key through the installed table.
//
// @param key The lang key.
// @param args Substitution arguments from a rawtext "with" field.
// @returns the substituted template and true, or ("", false) when the table
// is absent or the key unknown.
func translateKey(key string, args []string) (string, bool) {
	t := activeLang.Load()
	if t == nil {
		return "", false
	}
	tmpl, ok := (*t)[key]
	if !ok {
		return "", false
	}
	return substituteLang(tmpl, args), true
}

// substituteLang fills Bedrock lang placeholders: %1–%9 positional, Java-style
// %1$s / %2$d (digit + `$` + conversion letter), %s sequential over the
// remaining unused args, %% a literal percent ("lost %s%% of its health!"
// rendered "20%%" until the escape was handled). Unmatched placeholders stay
// verbatim so a short "with" is visible rather than silently eaten.
//
// @param tmpl The lang template.
// @param args Substitution arguments, possibly short or empty.
// @returns the template with placeholders replaced.
func substituteLang(tmpl string, args []string) string {
	return applyLangPlaceholders(tmpl, args, false)
}

// applyLangPlaceholders fills lang placeholders. When stripUnfilled is true,
// unmatched %s / %N / %N$x tokens are dropped instead of left literal — used
// for bare-key resolveLangLines so recordings never show "%1$s suffocated…".
//
// @param tmpl The lang template.
// @param args Substitution arguments, possibly short or empty.
// @param stripUnfilled When true, omit placeholders that have no matching arg.
// @returns the template with placeholders replaced (or stripped).
func applyLangPlaceholders(tmpl string, args []string, stripUnfilled bool) string {
	if !strings.Contains(tmpl, "%") {
		return tmpl
	}
	var b strings.Builder
	next := 0 // next sequential %s argument
	for i := 0; i < len(tmpl); i++ {
		c := tmpl[i]
		if c != '%' || i+1 >= len(tmpl) {
			b.WriteByte(c)
			continue
		}
		n := tmpl[i+1]
		switch {
		case n == '%':
			b.WriteByte('%')
			i++
			continue
		case n == 's':
			if next < len(args) {
				b.WriteString(args[next])
				next++
				i++
				continue
			}
			if stripUnfilled {
				i++
				continue
			}
		case n >= '1' && n <= '9':
			idx, _ := strconv.Atoi(string(n))
			// %1$s / %1$d — consume `$` + one conversion letter when present.
			advance := 1
			if i+3 < len(tmpl) && tmpl[i+2] == '$' {
				conv := tmpl[i+3]
				if (conv >= 'a' && conv <= 'z') || (conv >= 'A' && conv <= 'Z') {
					advance = 3
				}
			}
			if idx <= len(args) {
				b.WriteString(args[idx-1])
				if idx > next {
					next = idx
				}
				i += advance
				continue
			}
			if stripUnfilled {
				i += advance
				continue
			}
		}
		b.WriteByte(c)
	}
	return b.String()
}

// resolveLangLines translates lines that are exactly one lang key — the form
// the addon's battle buttons take ("showdown.moves.growl.shortDesc" alone on
// a line). Mixed-content lines pass through: substring translation would
// corrupt ordinary text that merely mentions a key-shaped word.
// Bare-key lookup has no args, so unfilled %N / %N$s tokens are stripped.
//
// @param text Flattened multi-line text.
// @returns text with whole-key lines resolved.
func resolveLangLines(text string) string {
	t := activeLang.Load()
	if t == nil || text == "" {
		return text
	}
	lines := strings.Split(text, "\n")
	changed := false
	for i, line := range lines {
		if v, ok := (*t)[strings.TrimSpace(line)]; ok {
			lines[i] = strings.Join(strings.Fields(applyLangPlaceholders(v, nil, true)), " ")
			changed = true
		}
	}
	if !changed {
		return text
	}
	return strings.Join(lines, "\n")
}

// resolveTranslationParameters resolves one level of nested translate keys in
// Text-packet Parameters (same depth flattenRawtext uses for "with" args).
//
// @param params Raw Parameters from packet.Text.
// @returns args ready for substituteLang.
func resolveTranslationParameters(params []string) []string {
	if len(params) == 0 {
		return nil
	}
	out := make([]string, len(params))
	for i, p := range params {
		if resolved, ok := translateKey(p, nil); ok {
			out[i] = strings.Join(strings.Fields(applyLangPlaceholders(resolved, nil, true)), " ")
			continue
		}
		out[i] = p
	}
	return out
}

// renderChatMessage turns a buffered chat/system/translation message into
// player-facing text for the viewer HUD.
//
// @param m A message from the actor ring (text ± Text-packet Parameters).
// @returns the resolved display string.
func renderChatMessage(m actor.ReceivedMessage) string {
	text := flattenRawtext(m.Text)
	if len(m.Parameters) == 0 {
		return resolveLangLines(text)
	}
	args := resolveTranslationParameters(m.Parameters)
	key := strings.TrimSpace(text)
	if resolved, ok := translateKey(key, args); ok {
		return resolved
	}
	var b strings.Builder
	b.WriteString(key)
	for _, arg := range args {
		if arg == "" {
			continue
		}
		b.WriteByte(' ')
		b.WriteString(arg)
	}
	return b.String()
}
