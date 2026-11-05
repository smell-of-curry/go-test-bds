package gotestbds

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

type itemSessionConn struct {
	packets []packet.Packet
	closed  chan struct{}
	once    sync.Once
}

func (c *itemSessionConn) IdentityData() login.IdentityData {
	return login.IdentityData{Identity: "11111111-1111-1111-1111-111111111111", DisplayName: "InputTest"}
}
func (c *itemSessionConn) GameData() minecraft.GameData {
	return minecraft.GameData{EntityRuntimeID: 1, EntityUniqueID: 1, ChunkRadius: 4}
}
func (c *itemSessionConn) WritePacket(pk packet.Packet) error {
	c.packets = append(c.packets, pk)
	return nil
}
func (c *itemSessionConn) ReadPacket() (packet.Packet, error) {
	<-c.closed
	return nil, io.EOF
}
func (c *itemSessionConn) Close() error {
	c.once.Do(func() { close(c.closed) })
	return nil
}

type itemSessionHandler struct {
	actor.NopHandler
	err   error
	close func() error
}

func (h *itemSessionHandler) HandleTick(a *actor.Actor, tick uint64) {
	if tick == 0 {
		a.StartSneaking()
		h.err = a.UseItem()
	} else {
		_ = h.close()
	}
}

// Exercise Test -> Bot -> Actor before the first real session tick. This catches
// a working CLI/actor option accidentally left unwired in the session runner.
func TestSessionPropagatesItemInteractionTransport(t *testing.T) {
	for _, transport := range []actor.ItemInteractionTransport{"", actor.ItemInteractionAuthInput, actor.ItemInteractionInventoryTransaction} {
		t.Run(string(transport), func(t *testing.T) {
			conn := &itemSessionConn{closed: make(chan struct{})}
			handler := &itemSessionHandler{}
			runner := &Test{Logger: slog.New(slog.DiscardHandler), ItemInteractionTransport: transport}
			runner.prepare()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err := runner.drive(ctx, conn, sessionOpts{skipSpawnGrace: true, ready: func(b *bot.Bot) {
				handler.close = b.Close
				b.SetHandler(handler)
			}}); err != nil {
				t.Fatal(err)
			}
			if ctx.Err() != nil || handler.err != nil {
				t.Fatalf("session did not run input: context=%v use=%v", ctx.Err(), handler.err)
			}
			standalone, embedded := 0, 0
			for _, pk := range conn.packets {
				switch pk := pk.(type) {
				case *packet.InventoryTransaction:
					standalone++
				case *packet.PlayerAuthInput:
					if pk.InputData.Load(packet.InputFlagPerformItemInteraction) {
						embedded++
					}
					if !pk.InputData.Load(packet.InputFlagSneakDown) {
						t.Fatal("session lost held sneak input")
					}
				}
			}
			if transport == actor.ItemInteractionInventoryTransaction {
				if standalone != 1 || embedded != 0 {
					t.Fatalf("legacy session sent %d standalone / %d embedded uses", standalone, embedded)
				}
			} else if standalone != 0 || embedded != 1 {
				t.Fatalf("default/auth session sent %d standalone / %d embedded uses", standalone, embedded)
			}
		})
	}
}

func TestInvalidItemTransportFailsBeforeDial(t *testing.T) {
	runner := &Test{ItemInteractionTransport: "auto"}
	if err := runner.RunCtx(context.Background()); err == nil {
		t.Fatal("invalid transport reached dial")
	}
}
