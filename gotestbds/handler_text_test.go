package gotestbds

import (
	"io"
	"log/slog"
	"reflect"
	"testing"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

func TestExtractMessageContent(t *testing.T) {
	h := TestingHandler{cfg: &Test{InstructionPrefix: DefaultInstructionPrefix}}
	const translated = `{"rawtext":[{"text":"§e"},{"translate":"example.notice","with":["Pikachu"]}]}`
	tests := []struct{ msg, want string }{
		{`ordinary chat`, `ordinary chat`},
		{`{"rawtext":[{"text":"abc"},{"text":" def"}]}`, `abc def`},
		{`example.notice`, `example.notice`},
		{translated, translated},
		{`{"rawtext":[{"translate":"example.notice"}]}`, `{"rawtext":[{"translate":"example.notice"}]}`},
		{`{"rawtext":[{"text":"[RUN_ACTION]{\"action\":\"getMessages\"}"},{"text":" ignored"}]}`, `[RUN_ACTION]{"action":"getMessages"}`},
		{`{"rawtext":[{"text":"[STATUS][]"}]}`, `[STATUS][]`},
	}
	for _, tt := range tests {
		if got := h.extractMessageContent(tt.msg); got != tt.want {
			t.Errorf("extractMessageContent(%q) = %q, want %q", tt.msg, got, tt.want)
		}
	}
}

func TestHandleReceiveMessagePreservesTranslatedPacketParameters(t *testing.T) {
	h := TestingHandler{
		cfg:    &Test{InstructionPrefix: DefaultInstructionPrefix},
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	a := &actor.Actor{}
	args := []string{"Pikachu", "10"}
	h.HandleReceiveMessage(a, "example.notice", args)
	messages := a.RecentMessages(1)
	if len(messages) != 1 || messages[0].Text != "example.notice" || !reflect.DeepEqual(messages[0].Parameters, args) {
		t.Fatalf("translated packet was changed: %#v", messages)
	}
}
