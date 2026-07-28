package gotestbds

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestEncodeStatusMessagesSmall(t *testing.T) {
	payload := `{"id":"7","status":"success"}`
	msgs := EncodeStatusMessages("7", payload)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0] != StatusMessagePrefix+payload {
		t.Fatalf("unexpected message: %s", msgs[0])
	}
}

func TestEncodeStatusMessagesChunked(t *testing.T) {
	// A multi-KB payload with multi-byte runes sprinkled in, like § colour
	// codes in form button text.
	payload := strings.Repeat(`{"text":"§aStarter §rPokémon option"},`, 120)
	msgs := EncodeStatusMessages("42", payload)
	if len(msgs) < 2 {
		t.Fatalf("expected chunked output, got %d message(s)", len(msgs))
	}
	var rebuilt strings.Builder
	for i, msg := range msgs {
		if len(msg) > maxStatusChatBytes {
			t.Fatalf("message %d exceeds chat budget: %d bytes", i, len(msg))
		}
		rest, ok := strings.CutPrefix(msg, StatusPartPrefix)
		if !ok {
			t.Fatalf("message %d missing part prefix: %s", i, msg)
		}
		wantHeader := fmt.Sprintf("42:%d/%d:", i+1, len(msgs))
		fragment, ok := strings.CutPrefix(rest, wantHeader)
		if !ok {
			t.Fatalf("message %d has wrong header, want %q got %q", i, wantHeader, rest[:min(len(rest), 20)])
		}
		if !utf8.ValidString(fragment) {
			t.Fatalf("message %d split mid-rune", i)
		}
		rebuilt.WriteString(fragment)
	}
	if rebuilt.String() != payload {
		t.Fatalf("reassembled payload does not match original")
	}
}
