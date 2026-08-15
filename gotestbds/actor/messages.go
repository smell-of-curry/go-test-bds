package actor

import (
	"sync"
	"time"
)

// messageRingCap is the maximum number of recent messages retained.
const messageRingCap = 200

// ReceivedMessage is a chat/system message retained for observation instructions.
// Parameters carries packet.Text substitution args for TextTypeTranslation
// (and tip/popup); empty for ordinary chat.
type ReceivedMessage struct {
	Text         string   `json:"text"`
	Parameters   []string `json:"parameters,omitempty"`
	ReceivedAtMs int64    `json:"receivedAtMs"`
}

// messageRing is a bounded, mutex-protected ring buffer of received messages.
type messageRing struct {
	mu    sync.Mutex
	items []ReceivedMessage
	// nextSeq is a monotonically increasing write counter used by waiters.
	nextSeq uint64
	// seqs tracks the sequence number of each buffered message (parallel to items).
	seqs []uint64
}

// RecordMessage appends a received message to the ring buffer.
//
// @param text The message body (plain chat, or a translate key).
// @param parameters Optional Text-packet substitution arguments.
func (a *Actor) RecordMessage(text string, parameters ...string) {
	if a.messages == nil {
		a.messages = &messageRing{}
	}
	a.messages.append(text, parameters, time.Now().UnixMilli())
}

// RecentMessages returns up to limit of the most recent messages, oldest first.
// When limit <= 0, all buffered messages are returned.
func (a *Actor) RecentMessages(limit int) []ReceivedMessage {
	if a.messages == nil {
		return nil
	}
	return a.messages.recent(limit)
}

// MessageSeq returns the current write sequence of the message ring.
// Messages appended after this call receive a strictly greater sequence number.
func (a *Actor) MessageSeq() uint64 {
	if a.messages == nil {
		return 0
	}
	return a.messages.seq()
}

// MessagesFromSeq returns buffered messages with sequence > afterSeq, oldest first.
func (a *Actor) MessagesFromSeq(afterSeq uint64) []ReceivedMessage {
	if a.messages == nil {
		return nil
	}
	return a.messages.fromSeq(afterSeq)
}

func (r *messageRing) append(text string, parameters []string, receivedAtMs int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nextSeq++
	var params []string
	if len(parameters) > 0 {
		params = append([]string(nil), parameters...)
	}
	msg := ReceivedMessage{Text: text, Parameters: params, ReceivedAtMs: receivedAtMs}
	r.items = append(r.items, msg)
	r.seqs = append(r.seqs, r.nextSeq)
	if len(r.items) > messageRingCap {
		trim := len(r.items) - messageRingCap
		r.items = append([]ReceivedMessage(nil), r.items[trim:]...)
		r.seqs = append([]uint64(nil), r.seqs[trim:]...)
	}
}

func (r *messageRing) seq() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.nextSeq
}

func (r *messageRing) recent(limit int) []ReceivedMessage {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.items) == 0 {
		return nil
	}
	start := 0
	if limit > 0 && limit < len(r.items) {
		start = len(r.items) - limit
	}
	out := make([]ReceivedMessage, len(r.items)-start)
	copy(out, r.items[start:])
	return out
}

func (r *messageRing) fromSeq(afterSeq uint64) []ReceivedMessage {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []ReceivedMessage
	for i, seq := range r.seqs {
		if seq > afterSeq {
			out = append(out, r.items[i])
		}
	}
	return out
}
