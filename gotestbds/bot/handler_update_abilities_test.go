package bot

import (
	"testing"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

func TestLoadingScreenAbilityFinishesLoadingOnce(t *testing.T) {
	a, conn := newRecordingActor(t)
	conn.written = nil

	pk := &packet.UpdateAbilities{AbilityData: protocol.AbilityData{
		PlayerPermissions:  1,
		CommandPermissions: 0,
		Layers: []protocol.AbilityLayer{{
			Type:      protocol.AbilityLayerTypeLoadingScreen,
			Abilities: protocol.AbilityBuild | protocol.AbilityMine,
			Values:    0,
		}},
	}}
	if err := (&UpdateAbilitiesHandler{}).Handle(pk, nil, a); err != nil {
		t.Fatal(err)
	}
	if a.AbilityNote() != "p=1/0,t5:3/0" {
		t.Fatalf("note = %s", a.AbilityNote())
	}
	if len(conn.written) != 1 {
		t.Fatalf("packets = %d, want one loading-screen end", len(conn.written))
	}
	loading, ok := conn.written[0].(*packet.ServerBoundLoadingScreen)
	if !ok || loading.Type != packet.LoadingScreenTypeEnd {
		t.Fatalf("packet = %#v, want loading-screen end", conn.written[0])
	}

	conn.written = nil
	if err := (&UpdateAbilitiesHandler{}).Handle(pk, nil, a); err != nil {
		t.Fatal(err)
	}
	if len(conn.written) != 0 {
		t.Fatalf("second update wrote %d packets, want 0", len(conn.written))
	}
}
