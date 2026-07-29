package actor

import (
	"encoding/json"
	"strings"
)

// Text is a piece of UI text received from the server.
//
// Bedrock lets a server write these as either a plain JSON string or a rawtext
// object, and addons that localise their interface send the latter, so a plain
// `string` field fails to unmarshal against any translated form. Text accepts
// both.
//
// Text deliberately never fails to unmarshal. It is reached from packet
// handlers, where returning an error disconnects the bot — losing a whole test
// run because one label had a shape we did not anticipate is far worse than
// reporting that label as its raw JSON.
type Text string

// String returns the text as a plain string.
func (t Text) String() string {
	return string(t)
}

// UnmarshalJSON decodes either a JSON string or a rawtext object.
//
// @param data The raw JSON value.
// @returns nil, always: unrecognised shapes decode to their raw JSON rather
// than erroring.
func (t *Text) UnmarshalJSON(data []byte) error {
	*t = Text(flattenText(data))
	return nil
}

// rawText mirrors the shapes Bedrock accepts wherever UI text is expected.
type rawText struct {
	// RawText holds the parts of a `{"rawtext":[…]}` wrapper.
	RawText []rawText `json:"rawtext"`
	// Text is a literal run of text.
	Text *string `json:"text"`
	// Translate is a `.lang` key. Bots have no language files, so the key
	// itself is the most useful thing we can report.
	Translate *string `json:"translate"`
	// With carries a translate part's substitution arguments.
	With json.RawMessage `json:"with"`
}

// flattenText renders a JSON UI text value as a readable string.
//
// A translate part that carries `with` args is NOT flattened: rendering it
// would drop the args, and the viewer's lang table can only substitute them
// from the original envelope ("Accuracy: %s%" stayed unfilled on every battle
// form because this flatten ran at packet-decode time). Argless shapes still
// flatten to readable text.
//
// @param data The raw JSON value.
// @returns the flattened text, or the raw JSON when the shape is unrecognised
// or must keep its substitution args.
func flattenText(data []byte) string {
	var literal string
	if json.Unmarshal(data, &literal) == nil {
		return literal
	}

	var parsed rawText
	if json.Unmarshal(data, &parsed) != nil {
		return string(data)
	}
	if parsed.hasArgs() {
		return string(data)
	}

	rendered := parsed.render()
	if rendered == "" {
		return string(data)
	}
	return rendered
}

// hasArgs reports whether any translate part in the tree carries "with" args.
//
// @returns true when flattening would lose substitution arguments.
func (r rawText) hasArgs() bool {
	if r.Translate != nil && withHasValues(r.With) {
		return true
	}
	for _, part := range r.RawText {
		if part.hasArgs() {
			return true
		}
	}
	return false
}

// withHasValues reports whether a "with" field carries at least one argument
// (an empty array or envelope loses nothing when flattened).
//
// @param raw The raw JSON of the "with" field.
// @returns true when substitution arguments are present.
func withHasValues(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var plain []json.RawMessage
	if json.Unmarshal(raw, &plain) == nil {
		return len(plain) > 0
	}
	var nested rawText
	if json.Unmarshal(raw, &nested) == nil {
		return len(nested.RawText) > 0
	}
	return false
}

// render walks a rawtext tree, concatenating its parts in order.
//
// @returns the rendered text, empty when the node carried none.
func (r rawText) render() string {
	if r.Text != nil {
		return *r.Text
	}
	if r.Translate != nil {
		return *r.Translate
	}

	var out strings.Builder
	for _, part := range r.RawText {
		out.WriteString(part.render())
	}
	return out.String()
}
