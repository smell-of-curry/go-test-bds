package gotestbds

import (
	"fmt"
	"time"
)

const (
	// StatusSuccess indicates the instruction completed without error.
	StatusSuccess = "success"
	// StatusError indicates the instruction failed.
	StatusError = "error"
	// StatusTimeOut indicates the instruction exceeded its timeout.
	StatusTimeOut = "timeout"
)

const (
	// StatusMessagePrefix prefixes outbound status chat messages.
	StatusMessagePrefix = "[STATUS]"
	// StatusPartPrefix prefixes one fragment of a chunked status message:
	// "[STATUSPART]<id>:<index>/<total>:<fragment>" with a 1-based index.
	StatusPartPrefix = "[STATUSPART]"
)

// maxStatusChatBytes bounds a single status chat message. BDS silently drops
// inbound chat past ~512 characters, so envelopes larger than this are split
// into StatusPartPrefix fragments that the SDK reassembles.
const maxStatusChatBytes = 300

// EncodeStatusMessages turns a marshalled status envelope into one or more
// chat-sized messages. Envelopes that fit in a single chat message use the
// plain [STATUS] form; larger ones become [STATUSPART] fragments. Fragments
// split on rune boundaries so multi-byte characters survive the chat channel.
//
// The id parameter is the instruction id echoed in each fragment header so
// the SDK can reassemble interleaved envelopes from one bot.
func EncodeStatusMessages(id, payload string) []string {
	if len(StatusMessagePrefix)+len(payload) <= maxStatusChatBytes {
		return []string{StatusMessagePrefix + payload}
	}
	// Reserve room for the header; totals are small so 32 bytes is plenty.
	budget := maxStatusChatBytes - len(StatusPartPrefix) - len(id) - 32
	var fragments []string
	remaining := payload
	for len(remaining) > 0 {
		cut := budget
		if cut >= len(remaining) {
			cut = len(remaining)
		} else {
			// Back up to a rune boundary so we never split a character.
			for cut > 0 && remaining[cut]&0xC0 == 0x80 {
				cut--
			}
		}
		fragments = append(fragments, remaining[:cut])
		remaining = remaining[cut:]
	}
	messages := make([]string, len(fragments))
	for i, fragment := range fragments {
		messages[i] = fmt.Sprintf("%s%s:%d/%d:%s", StatusPartPrefix, id, i+1, len(fragments), fragment)
	}
	return messages
}

// DefaultInstructionTimeout is used when a request omits timeoutMs and Test.DefaultInstructionTimeout is zero.
const DefaultInstructionTimeout = 20 * time.Second
