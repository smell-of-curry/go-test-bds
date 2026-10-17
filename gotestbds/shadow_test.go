package gotestbds

import (
	"encoding/binary"
	"io"
	"log/slog"
	"testing"

	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

type fakeShadowServer struct {
	pks    []packet.Packet
	i      int
	closed bool
}

func (f *fakeShadowServer) ReadPacket() (packet.Packet, error) {
	if f.i >= len(f.pks) {
		return nil, io.EOF
	}
	pk := f.pks[f.i]
	f.i++
	return pk, nil
}

func (f *fakeShadowServer) IdentityData() login.IdentityData {
	return login.IdentityData{DisplayName: "Steve"}
}

func (f *fakeShadowServer) GameData() minecraft.GameData {
	return minecraft.GameData{EntityRuntimeID: 7}
}

func (f *fakeShadowServer) Close() error {
	f.closed = true
	return nil
}

type fakeShadowClient struct {
	got []packet.Packet
}

func (f *fakeShadowClient) WritePacket(pk packet.Packet) error {
	f.got = append(f.got, pk)
	return nil
}

func (f *fakeShadowClient) Close() error { return nil }

// TestShadowTeeForwardsServerDropsBot: server packets reach the client sink
// before the bot sees them, and bot writes never reach the sink.
func TestShadowTeeForwardsServerDropsBot(t *testing.T) {
	srv := &fakeShadowServer{pks: []packet.Packet{
		&packet.Text{Message: "from-server"},
	}}
	cli := &fakeShadowClient{}
	tee := newShadowTee(srv, cli, slog.New(slog.DiscardHandler))

	pk, err := tee.ReadPacket()
	if err != nil {
		t.Fatal(err)
	}
	text, ok := pk.(*packet.Text)
	if !ok || text.Message != "from-server" {
		t.Fatalf("bot packet = %#v", pk)
	}
	if len(cli.got) != 1 {
		t.Fatalf("client received %d packets, want 1", len(cli.got))
	}
	if got, ok := cli.got[0].(*packet.Text); !ok || got.Message != "from-server" {
		t.Fatalf("client packet = %#v", cli.got[0])
	}

	if err := tee.WritePacket(&packet.Text{Message: "from-bot"}); err != nil {
		t.Fatal(err)
	}
	if len(cli.got) != 1 {
		t.Fatalf("bot write leaked to client: %d packets", len(cli.got))
	}
	if tee.IdentityData().DisplayName != "Steve" {
		t.Fatalf("identity = %q", tee.IdentityData().DisplayName)
	}
	if tee.GameData().EntityRuntimeID != 7 {
		t.Fatalf("runtime id = %d", tee.GameData().EntityRuntimeID)
	}

	if err := tee.Close(); err != nil {
		t.Fatal(err)
	}
	if !srv.closed {
		t.Fatal("server was not closed")
	}
}

// TestClampUnknownPackSizes rewrites BDS's ^uint64(0) pack size so gophertunnel
// does not preallocate it. A modest size is left alone.
func TestClampUnknownPackSizes(t *testing.T) {
	var payload []byte
	payload = append(payload, 1, 0, 0, 0)          // flags
	payload = append(payload, make([]byte, 16)...) // template uuid
	payload = append(payload, 0)                   // empty template version
	payload = append(payload, 1)                   // one pack
	payload = append(payload, make([]byte, 16)...) // pack uuid
	payload = append(payload, 1, '1')              // version "1"
	sizeAt := len(payload)
	payload = append(payload, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)
	payload = append(payload, 0, 0, 0) // three empty strings: content key, subpack, identity
	payload = append(payload, 0, 0, 0) // three bools
	payload = append(payload, 0)       // empty url

	if ids := clampUnknownPackSizes(payload); len(ids) != 1 {
		t.Fatalf("clamped %d, want 1", len(ids))
	}
	if binary.LittleEndian.Uint64(payload[sizeAt:sizeAt+8]) != 0 {
		t.Fatal("sentinel size was not zeroed")
	}

	modest := append([]byte(nil), payload...)
	binary.LittleEndian.PutUint64(modest[sizeAt:sizeAt+8], 1024)
	if ids := clampUnknownPackSizes(modest); len(ids) != 0 {
		t.Fatalf("modest size clamped %d times", len(ids))
	}
}
