package bot

import (
	"log/slog"
)

// chatOutBuf bounds queued outbound status chat. When full, EnqueueChat drops
// the newest message rather than blocking the producer — a blocked WritePacket
// on the tick loop (via Execute→Chat) froze showcase runs after arena battle
// when chunked [STATUS] floods met RakNet backpressure (slowestPacket=*packet.Text).
const chatOutBuf = 64

// startChatWriter drains EnqueueChat off the tick loop.
//
// Conn.WritePacket is safe from this goroutine; the point is that a slow or
// stalled write must never stop Actor.Tick / packet / task handling.
func (b *Bot) startChatWriter() {
	if b.chatOut == nil {
		b.chatOut = make(chan string, chatOutBuf)
	}
	go func() {
		for {
			select {
			case <-b.closed:
				return
			case msg := <-b.chatOut:
				b.a.Chat(msg)
			}
		}
	}()
}

// EnqueueChat queues a chat line for the background writer. Non-blocking:
// drops when the buffer is full so status floods cannot stall callers or the
// tick loop.
//
// @param msg The chat message (already prefixed, e.g. [STATUS]…).
func (b *Bot) EnqueueChat(msg string) {
	if b.chatOut == nil {
		// Tests that never StartTickLoop still need Chat to work.
		b.a.Chat(msg)
		return
	}
	select {
	case b.chatOut <- msg:
	default:
		if b.logger != nil {
			b.logger.Warn("status chat dropped", slog.Int("buf", chatOutBuf))
		}
	}
}
