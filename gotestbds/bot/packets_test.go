package bot

import (
	"io"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-gl/mathgl/mgl32"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// floodConn delivers count packets from ReadPacket, then blocks until Close.
// Counts how many times ReadPacket was entered so tests can prove the reader
// keeps pulling even when the tick loop is not draining b.packets.
type floodConn struct {
	stubConn
	remain atomic.Int32
	reads  atomic.Int32
	closed chan struct{}
}

func (c *floodConn) ReadPacket() (packet.Packet, error) {
	c.reads.Add(1)
	if c.remain.Add(-1) >= 0 {
		return &packet.SetTime{Time: 1}, nil
	}
	<-c.closed
	return nil, io.EOF
}

func (c *floodConn) Close() error {
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
	return nil
}

// TestHandlePacketsKeepsReadingWhenQueueFull: a stuck tick loop used to make
// `b.packets <- pk` block forever, which stopped ReadPacket / RakNet ACKs and
// deadlocked every WritePacket on the tick loop (post-arena showcase hang).
func TestHandlePacketsKeepsReadingWhenQueueFull(t *testing.T) {
	// More packets than the buffer — reader must not stall on enqueue.
	const n = packetBuf + 64
	conn := &floodConn{
		stubConn: stubConn{game: minecraft.GameData{
			EntityRuntimeID: 1,
			EntityUniqueID:  1,
			PlayerPosition:  mgl32.Vec3{0, 70, 0},
			ChunkRadius:     4,
		}},
		closed: make(chan struct{}),
	}
	conn.remain.Store(int32(n))
	b := NewBot(conn, nil)

	go b.handlePackets()
	defer func() {
		_ = b.Close()
		_ = conn.Close()
	}()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if int(conn.reads.Load()) >= n {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("ReadPacket calls=%d want>=%d — handlePackets blocked on full packets chan",
		conn.reads.Load(), n)
}

// TestEnqueuePacketDropsOldestWhenFull covers the non-blocking buffer policy.
func TestEnqueuePacketDropsOldestWhenFull(t *testing.T) {
	conn := &floodConn{
		stubConn: stubConn{game: minecraft.GameData{
			EntityRuntimeID: 1,
			EntityUniqueID:  1,
			PlayerPosition:  mgl32.Vec3{0, 70, 0},
			ChunkRadius:     4,
		}},
		closed: make(chan struct{}),
	}
	b := NewBot(conn, nil)
	defer func() {
		_ = b.Close()
		_ = conn.Close()
	}()

	for i := 0; i < packetBuf; i++ {
		if !b.enqueuePacket(&packet.SetTime{Time: int32(i)}) {
			t.Fatalf("enqueue failed at %d", i)
		}
	}
	// One more must not block and must succeed (drop oldest).
	done := make(chan bool, 1)
	go func() { done <- b.enqueuePacket(&packet.SetTime{Time: 99999}) }()
	select {
	case ok := <-done:
		if !ok {
			t.Fatal("enqueue returned false on open bot")
		}
	case <-time.After(time.Second):
		t.Fatal("enqueuePacket blocked when buffer full")
	}
	if len(b.packets) != packetBuf {
		t.Fatalf("len(packets)=%d want %d", len(b.packets), packetBuf)
	}
}
