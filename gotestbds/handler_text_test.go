package gotestbds

import (
	"io"
	"log/slog"
	"slices"
	"testing"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

func TestExtractControlMessageRetainsWrapperBoundaries(t *testing.T) {
	tests := []struct {
		msg, want string
		rawText   bool
	}{
		{`[RUN_ACTION]{"action":"getMessages"}`, `[RUN_ACTION]{"action":"getMessages"}`, false},
		{`{"rawtext":[{"text":"[RUN_ACTION]{\"action\":\"getMessages\"}"},{"text":" ignored"}]}`, `[RUN_ACTION]{"action":"getMessages"}`, true},
		{`{"rawtext":[{"text":"[RUN_"},{"text":"ACTION]{\"action\":\"getMessages\"}"}]}`, `[RUN_`, true},
		{`{"rawtext":[{"text":"[STATUS][]"}]}`, `[STATUS][]`, true},
		{`"[RUN_ACTION]ordinary quoted text"`, `"[RUN_ACTION]ordinary quoted text"`, false},
		{`null`, `null`, false},
	}
	for _, tt := range tests {
		if got, raw := extractControlMessage(tt.msg); got != tt.want || raw != tt.rawText {
			t.Errorf("extractControlMessage(%q) = (%q, %t), want (%q, %t)", tt.msg, got, raw, tt.want, tt.rawText)
		}
	}
}

func TestHandleReceiveMessagePreservesChatAndTranslations(t *testing.T) {
	h := TestingHandler{
		cfg:    &Test{InstructionPrefix: DefaultInstructionPrefix},
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	const translated = `{"rawtext":[{"text":"§e"},{"translate":"example.notice","with":["Pikachu"]}]}`
	const keyOnly = `{"rawtext":[{"translate":"models.battle.error.invalidEntity"}]}`
	tests := []struct {
		msg, want string
		params    []string
	}{
		{`ordinary chat`, `ordinary chat`, nil},
		{`"[STATUS]ordinary quoted text"`, `"[STATUS]ordinary quoted text"`, nil},
		{`"[RUN_ACTION]ordinary quoted text"`, `"[RUN_ACTION]ordinary quoted text"`, nil},
		{`null`, `null`, nil},
		{`{"rawtext":[{"text":"abc"},{"text":" def"}]}`, `abc def`, nil},
		{`{"rawtext":[{"text":"[STA"},{"text":"TUS]literal"}]}`, `[STATUS]literal`, nil},
		{`{"rawtext":[{"text":"[RUN_"},{"text":"ACTION]literal"}]}`, `[RUN_ACTION]literal`, nil},
		{translated, translated, nil},
		{keyOnly, keyOnly, nil},
		{`example.notice`, `example.notice`, []string{"Pikachu", "10"}},
	}
	for _, tt := range tests {
		a := &actor.Actor{}
		h.HandleReceiveMessage(a, tt.msg, tt.params)
		messages := a.RecentMessages(1)
		if len(messages) != 1 || messages[0].Text != tt.want || !slices.Equal(messages[0].Parameters, tt.params) {
			t.Errorf("HandleReceiveMessage(%q) recorded %#v, want %q with %v", tt.msg, messages, tt.want, tt.params)
		}
	}
}
