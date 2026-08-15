package assets

import (
	"bytes"
	"net"

	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// WireDialer configures a Dialer so the connection accepts (or skips) server
// resource packs according to Manager, and captures ResourcePackStack order.
//
// When m is nil, DownloadResourcePack is left untouched (or forced false if
// clearDownload is set) so a normal test run downloads nothing.
//
// @param d Dialer to mutate.
// @param m Asset manager; nil means do not download packs.
func WireDialer(d *minecraft.Dialer, m *Manager) {
	if d == nil {
		return
	}
	prev := d.PacketFunc
	d.PacketFunc = func(header packet.Header, payload []byte, src, dst net.Addr) {
		if m != nil && header.PacketID == packet.IDResourcePackStack {
			if order, ok := decodeResourcePackStack(payload); ok {
				m.SetStackOrder(order)
			}
		}
		if prev != nil {
			prev(header, payload, src, dst)
		}
	}
	if m == nil {
		// Explicit refuse: a zero Dialer downloads every pack the server
		// offers. Viewer-disabled runs must not pay that cost.
		d.DownloadResourcePack = func(uuid.UUID, string, int, int) bool { return false }
		return
	}
	d.DownloadResourcePack = func(id uuid.UUID, version string, current, total int) bool {
		return m.ShouldDownload(id, version)
	}
}

func decodeResourcePackStack(payload []byte) ([]protocol.StackResourcePack, bool) {
	pk := &packet.ResourcePackStack{}
	r := protocol.NewReader(bytes.NewBuffer(payload), 0, false)
	func() {
		defer func() { _ = recover() }()
		pk.Marshal(r)
	}()
	if len(pk.TexturePacks) == 0 && !pk.TexturePackRequired && pk.BaseGameVersion == "" {
		// Likely a failed decode; treat as empty rather than poisoning state.
		// A real stack can be empty, which is fine.
		return pk.TexturePacks, true
	}
	return pk.TexturePacks, true
}
