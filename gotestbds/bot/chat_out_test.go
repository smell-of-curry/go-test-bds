package bot

import (
	"io"
	"testing"
	"time"

	"github.com/go-gl/mathgl/mgl32"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// blockingConn stalls Text WritePacket until unblock is closed — models RakNet
// backpressure on status chat (live: slowestPacket=*packet.Text → silence).
type blockingConn struct {
	stubConn
	unblock <-chan struct{}
	closed  chan struct{}
}

func (c *blockingConn) WritePacket(pk packet.Packet) error {
	if _, ok := pk.(*packet.Text); ok && c.unblock != nil {
		select {
		case <-c.unblock:
		case <-c.closed:
			return io.EOF
		}
	}
	return nil
}

func (c *blockingConn) ReadPacket() (packet.Packet, error) {
	<-c.closed
	return nil, io.EOF
}

func (c *blockingConn) Close() error {
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
	return nil
}

func (c *blockingConn) IdentityData() login.IdentityData {
	return c.stubConn.IdentityData()
}

// TestEnqueueChatDoesNotBlockWhenWriterStuck: status floods used to call
// Execute→Chat on the tick loop; a blocked WritePacket froze StartTickLoop.
// EnqueueChat must return even when the background writer is stuck in Chat.
func TestEnqueueChatDoesNotBlockWhenWriterStuck(t *testing.T) {
	unblock := make(chan struct{})
	closed := make(chan struct{})
	conn := &blockingConn{
		stubConn: stubConn{game: minecraft.GameData{
			EntityRuntimeID: 1,
			EntityUniqueID:  1,
			PlayerPosition:  mgl32.Vec3{0, 70, 0},
			ChunkRadius:     4,
		}},
		unblock: unblock,
		closed:  closed,
	}
	b := NewBot(conn, nil)
	b.startChatWriter()
	defer func() {
		_ = b.Close()
		_ = conn.Close()
		close(unblock)
	}()

	// First message occupies the writer (blocked in WritePacket).
	b.EnqueueChat("[STATUS]{\"status\":\"success\"}")
	time.Sleep(20 * time.Millisecond)

	// Further enqueues must not block the caller (drop when full).
	done := make(chan struct{})
	go func() {
		for i := 0; i < chatOutBuf+32; i++ {
			b.EnqueueChat("[STATUS]{\"status\":\"success\"}")
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("EnqueueChat blocked while status WritePacket stuck — would freeze tick loop via Execute")
	}
}

// TestWriteChatTimedClosesBotOnStuckWrite: a WritePacket that never returns
// must not leave BEH waiting on a dropped [STATUS] until manager timedOut.
func TestWriteChatTimedClosesBotOnStuckWrite(t *testing.T) {
	unblock := make(chan struct{})
	closed := make(chan struct{})
	conn := &blockingConn{
		stubConn: stubConn{game: minecraft.GameData{
			EntityRuntimeID: 1,
			EntityUniqueID:  1,
			PlayerPosition:  mgl32.Vec3{0, 70, 0},
			ChunkRadius:     4,
		}},
		unblock: unblock,
		closed:  closed,
	}
	b := NewBot(conn, nil)
	b.startChatWriter()
	defer func() {
		_ = b.Close()
		_ = conn.Close()
		close(unblock)
	}()

	b.EnqueueChat("[STATUS]{\"status\":\"success\"}")
	select {
	case <-b.Closed():
	case <-time.After(chatWriteTimeout + 2*time.Second):
		t.Fatal("bot should Close after status chat WritePacket timeout")
	}
}

// TestTryExecuteDropsWhenSaturated: a full task queue must not deadlock a
// producer the way bare Execute←tasks used to when Chat flooded the queue.
func TestTryExecuteDropsWhenSaturated(t *testing.T) {
	conn := &blockingConn{
		stubConn: stubConn{game: minecraft.GameData{
			EntityRuntimeID: 1,
			EntityUniqueID:  1,
			PlayerPosition:  mgl32.Vec3{0, 70, 0},
			ChunkRadius:     4,
		}},
		closed: make(chan struct{}),
	}
	b := NewBot(conn, nil)
	// Fill task buffer without draining (tick loop not started).
	for i := 0; i < 256; i++ {
		if !b.TryExecute(func(*actor.Actor) {}) {
			t.Fatalf("failed to fill tasks at i=%d", i)
		}
	}
	if b.TryExecute(func(*actor.Actor) {}) {
		t.Fatal("TryExecute should drop when tasks are full")
	}
	_ = b.Close()
	_ = conn.Close()
}
