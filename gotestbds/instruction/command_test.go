package instruction

import (
	"testing"

	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

func TestCommandPacket(t *testing.T) {
	origin := uuid.MustParse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")

	pk, err := CommandPacket("summon pokemon:snorlax 10 64 10", origin, 42)
	if err != nil {
		t.Fatal(err)
	}
	if pk.CommandLine != "/summon pokemon:snorlax 10 64 10" {
		t.Fatalf("line %q", pk.CommandLine)
	}
	if pk.CommandOrigin.Origin != protocol.CommandOriginPlayer {
		t.Fatalf("origin %d", pk.CommandOrigin.Origin)
	}
	if pk.CommandOrigin.UUID != origin {
		t.Fatalf("uuid %s", pk.CommandOrigin.UUID)
	}
	if pk.CommandOrigin.PlayerUniqueID != 42 {
		t.Fatalf("player %d", pk.CommandOrigin.PlayerUniqueID)
	}
	if pk.Internal {
		t.Fatal("internal should be false")
	}

	withSlash, err := CommandPacket("  /tp @s 0 64 0  ", origin, 1)
	if err != nil {
		t.Fatal(err)
	}
	if withSlash.CommandLine != "/tp @s 0 64 0" {
		t.Fatalf("line %q", withSlash.CommandLine)
	}

	if _, err := CommandPacket("   ", origin, 1); err == nil {
		t.Fatal("empty command should fail")
	}
}

func TestEmotePacket(t *testing.T) {
	pk := EmotePacket(7, "")
	if pk.EntityRuntimeID != 7 {
		t.Fatalf("rid %d", pk.EntityRuntimeID)
	}
	if pk.EmoteID != DefaultEmoteID {
		t.Fatalf("id %s", pk.EmoteID)
	}
	if pk.Flags&packet.EmoteFlagServerSide != 0 {
		t.Fatalf("flags %d include ServerSide", pk.Flags)
	}

	custom := EmotePacket(1, "12345678-1234-1234-1234-123456789abc")
	if custom.EmoteID != "12345678-1234-1234-1234-123456789abc" {
		t.Fatalf("id %s", custom.EmoteID)
	}
}

func TestDefaultPullHasCommandAndEmote(t *testing.T) {
	pull := DefaultPull(nil)
	for _, name := range []string{"command", "emote", "runCommand", "swingArm"} {
		if _, ok := pull.Instruction(name); !ok {
			t.Fatalf("missing %s", name)
		}
	}
}
