package bot

import (
	"log/slog"
	"time"
)

// chatOutBuf bounds queued outbound status chat. When full, EnqueueChat drops
// the oldest message rather than blocking — a blocked WritePacket on the tick
// loop (via Execute→Chat) froze showcase runs after arena battle when chunked
// [STATUS] floods met RakNet backpressure (slowestPacket=*packet.Text).
const chatOutBuf = 64

// chatWriteTimeout bounds one Conn.WritePacket for status chat. A stuck write
// used to park startChatWriter forever; the buffer then filled and EnqueueChat
// dropped the failure/success [STATUS] BEH was awaiting — suite hung until the
// manager's 15m timedOut while StartTickLoop looked healthy.
const chatWriteTimeout = 3 * time.Second

// startChatWriter drains EnqueueChat off the tick loop.
//
// Conn.WritePacket is safe from this goroutine; the point is that a slow or
// stalled write must never stop Actor.Tick / packet / task handling. A write
// that exceeds chatWriteTimeout closes the bot so the run fails fast instead
// of hanging the suite.
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
				if !b.writeChatTimed(msg) {
					return
				}
			}
		}
	}()
}

// writeChatTimed sends one chat line with a deadline. Returns false when the
// bot should stop writing (closed or write timed out and conn was closed).
//
// @param msg The chat message.
// @returns false when the writer should exit.
func (b *Bot) writeChatTimed(msg string) bool {
	done := make(chan struct{})
	go func() {
		b.a.Chat(msg)
		close(done)
	}()
	select {
	case <-b.closed:
		return false
	case <-done:
		return true
	case <-time.After(chatWriteTimeout):
		if b.logger != nil {
			b.logger.Warn("status chat write timed out; closing bot",
				slog.Duration("timeout", chatWriteTimeout),
			)
		}
		_ = b.Close()
		return false
	}
}

// EnqueueChat queues a chat line for the background writer. Non-blocking:
// when the buffer is full the oldest line is dropped so the newest status
// (the one BEH is waiting on) is more likely to be delivered.
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
		return
	default:
	}
	// Drop oldest to make room for the newest status reply.
	select {
	case <-b.chatOut:
	default:
	}
	select {
	case b.chatOut <- msg:
	default:
		if b.logger != nil {
			b.logger.Warn("status chat dropped", slog.Int("buf", chatOutBuf))
		}
	}
}
