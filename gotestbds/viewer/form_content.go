package viewer

import (
	"bytes"
	"encoding/json"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// formContent encodes display text for menu/modal forms and structured controls
// for custom forms. Rawtext must never be flattened across a JSON container:
// replacing an embedded object with unquoted text would corrupt the snapshot.
func formContent(f *actor.Form) string {
	if f.Type() != actor.FormTypeCustom {
		return resolveLangLines(flattenRawtext(f.ContentText()))
	}
	var shape struct {
		Content  json.RawMessage   `json:"content"`
		Elements []json.RawMessage `json:"elements"`
	}
	if json.Unmarshal([]byte(f.Raw()), &shape) != nil {
		return f.ContentText()
	}
	var controls []json.RawMessage
	if len(shape.Content) == 0 || bytes.Equal(bytes.TrimSpace(shape.Content), []byte("null")) || json.Unmarshal(shape.Content, &controls) != nil {
		// Current Bedrock also uses an elements array. Match the actor decoder:
		// buttons are not custom-form controls and must not shift response slots.
		controls = make([]json.RawMessage, 0, len(shape.Elements))
		for _, raw := range shape.Elements {
			var header struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &header) == nil && header.Type == "button" {
				continue
			}
			controls = append(controls, raw)
		}
	}
	for i, raw := range controls {
		var control map[string]json.RawMessage
		if json.Unmarshal(raw, &control) != nil || control == nil {
			continue
		}
		for _, key := range []string{"text", "placeholder"} {
			if value, ok := control[key]; ok {
				control[key] = localizeFormText(value)
			}
		}
		for _, key := range []string{"options", "steps"} {
			var labels []json.RawMessage
			value, ok := control[key]
			if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, &labels) != nil {
				continue
			}
			for j, label := range labels {
				labels[j] = localizeFormText(label)
			}
			control[key], _ = json.Marshal(labels)
		}
		// RawMessage leaves defaults, ranges and unknown fields intact, including
		// integers that would lose precision if decoded through float64.
		controls[i], _ = json.Marshal(control)
	}
	content, err := json.Marshal(controls)
	if err != nil {
		return f.ContentText()
	}
	return string(content)
}

// localizeFormText resolves one display value, then lets JSON escape its text.
// Non-text values are preserved rather than coerced into strings.
func localizeFormText(value json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) == 0 || (trimmed[0] != '"' && trimmed[0] != '{') {
		return value
	}
	if trimmed[0] == '{' {
		var object map[string]json.RawMessage
		if json.Unmarshal(value, &object) != nil {
			return value
		}
		if object["text"] == nil && object["translate"] == nil && object["rawtext"] == nil {
			return value
		}
	}
	var text actor.Text
	if json.Unmarshal(value, &text) != nil {
		return value
	}
	encoded, _ := json.Marshal(resolveLangLines(flattenRawtext(text.String())))
	return encoded
}
