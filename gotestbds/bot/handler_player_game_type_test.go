package bot

import (
	"io"
	"log/slog"
	"testing"

	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
)

type gameTypeConn struct{ recordingConn }

func (*gameTypeConn) ReadPacket() (packet.Packet, error) { return nil, io.EOF }
func (*gameTypeConn) Close() error                       { return nil }

func newGameTypeBot(t *testing.T, playerMode, worldMode int32) (*Bot, *gameTypeConn) {
	t.Helper()
	conn := &gameTypeConn{recordingConn: recordingConn{stubConn: stubConn{game: minecraft.GameData{
		EntityRuntimeID: 42,
		EntityUniqueID:  -17,
		PlayerGameMode:  playerMode,
		WorldGameMode:   worldMode,
	}}}}
	b := NewBot(conn, slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { _ = b.Close() })
	conn.written = nil
	return b, conn
}

// StartGame's mode 5 is inheritance, while an explicit player mode overrides
// the world default. This covers the stale 5 originally exposed by getState.
func TestPlayerGameTypeInitialDefaultUsesWorldMode(t *testing.T) {
	for _, tc := range []struct {
		name       string
		playerMode int32
		worldMode  int32
		want       int
	}{
		{"default survival", packet.GameTypeDefault, packet.GameTypeSurvival, packet.GameTypeSurvival},
		{"default creative", packet.GameTypeDefault, packet.GameTypeCreative, packet.GameTypeCreative},
		{"default adventure", packet.GameTypeDefault, packet.GameTypeAdventure, packet.GameTypeAdventure},
		{"default spectator", packet.GameTypeDefault, packet.GameTypeSpectator, packet.GameTypeSpectator},
		{"explicit survival", packet.GameTypeSurvival, packet.GameTypeCreative, packet.GameTypeSurvival},
		{"explicit creative", packet.GameTypeCreative, packet.GameTypeAdventure, packet.GameTypeCreative},
		{"explicit spectator", packet.GameTypeSpectator, packet.GameTypeAdventure, packet.GameTypeSpectator},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, _ := newGameTypeBot(t, tc.playerMode, tc.worldMode)
			if got := b.a.Gamemode(); got != tc.want {
				t.Fatalf("initial game mode = %d, want %d", got, tc.want)
			}
		})
	}
}

// Dispatch through HandlePacket rather than calling handlers directly, so a
// missing registration reproduces the observation failure too. Both protocol
// variants must follow spectator -> adventure and subsequent server changes.
func TestPlayerGameTypePacketsRegisteredAndApplyLocalMode(t *testing.T) {
	for _, tc := range []struct {
		name string
		make func(int32, int64) packet.Packet
	}{
		{"SetPlayerGameType", func(mode int32, _ int64) packet.Packet {
			return &packet.SetPlayerGameType{GameType: mode}
		}},
		{"UpdatePlayerGameType", func(mode int32, uid int64) packet.Packet {
			return &packet.UpdatePlayerGameType{GameType: mode, PlayerUniqueID: uid, Tick: 123}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, conn := newGameTypeBot(t, packet.GameTypeSurvival, packet.GameTypeCreative)
			for _, change := range []struct {
				mode int32
				want int
			}{
				{packet.GameTypeSpectator, packet.GameTypeSpectator},
				{packet.GameTypeAdventure, packet.GameTypeAdventure},
				{packet.GameTypeCreative, packet.GameTypeCreative},
				{packet.GameTypeSurvival, packet.GameTypeSurvival},
				{packet.GameTypeDefault, packet.GameTypeCreative},
			} {
				b.HandlePacket(tc.make(change.mode, b.a.UniqueID()))
				if got := b.a.Gamemode(); got != change.want {
					t.Fatalf("after server game type %d: mode = %d, want %d", change.mode, got, change.want)
				}
			}
			if len(conn.written) != 0 {
				t.Fatalf("observing server game-mode changes sent %d unexpected packets", len(conn.written))
			}
		})
	}
}

func TestUpdatePlayerGameTypeIgnoresOtherUniqueIDs(t *testing.T) {
	b, _ := newGameTypeBot(t, packet.GameTypeAdventure, packet.GameTypeSurvival)
	other := entity.CreateFromPacket(&packet.AddPlayer{
		EntityRuntimeID: 99,
		AbilityData:     protocol.AbilityData{EntityUniqueID: -23},
		GameType:        packet.GameTypeSurvival,
	}).(*entity.Player)
	b.a.World().AddEntity(other)
	for _, uid := range []int64{int64(b.a.RuntimeID()), other.UniqueID(), -999} {
		b.HandlePacket(&packet.UpdatePlayerGameType{
			GameType:       packet.GameTypeSpectator,
			PlayerUniqueID: uid,
		})
		if got := b.a.Gamemode(); got != packet.GameTypeAdventure {
			t.Fatalf("packet for unique ID %d changed local mode to %d", uid, got)
		}
		if got := other.Gamemode(); got != packet.GameTypeSurvival {
			t.Fatalf("packet for unique ID %d changed another player's mode to %d", uid, got)
		}
	}
}
