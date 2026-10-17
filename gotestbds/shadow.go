package gotestbds

import (
	"archive/zip"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/sandertv/gophertunnel/minecraft/resource"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/assets"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath"
	"github.com/smell-of-curry/go-test-bds/gotestbds/viewer"
)

// shadowEyeOffset is the vertical offset Actor.SendMovement adds when it writes
// PlayerAuthInput.Position (feet + 1.62). MovePlayerHandler uses the same
// constant under the name eyeOffset. Mirroring inverts it.
const shadowEyeOffset = 1.62

// A fresh offline name each probe so a crashed earlier probe does not sit on
// the server and reject the next dial as a duplicate.

// shadowProbeTimeout bounds the probe dial and spawn. A pack transfer that
// never answers would otherwise sit at 0% CPU with no log line.
const shadowProbeTimeout = 60 * time.Second

// Shadow is a pass-through proxy. A real Bedrock client dials Listen; the proxy
// dials RemoteAddress and feeds every server packet into a passive bot so the
// viewer hub renders the same stream the client is receiving.
type Shadow struct {
	Listen        string
	RemoteAddress string
	// Packs are local folders or .mcpack/.zip files. When non-empty the probe
	// does not download server packs; these are ingested and served instead.
	Packs  []string
	Logger *slog.Logger
	Viewer *viewer.Hub
	Assets *assets.Manager
}

// Run probes the server for resource packs, listens for real clients, and
// serves each session until ctx is cancelled.
//
// @param ctx Cancelled to stop listening and tear down the current session.
// @returns nil after a clean shutdown, or the error that stopped the listener.
func (s *Shadow) Run(ctx context.Context) error {
	if s.Logger == nil {
		s.Logger = slog.Default()
	}
	if s.Listen == "" {
		return fmt.Errorf("shadow listen address is empty")
	}
	if s.RemoteAddress == "" {
		return fmt.Errorf("shadow remote address is empty")
	}

	packs, err := s.probe(ctx)
	if err != nil {
		return err
	}

	listener, err := minecraft.ListenConfig{
		AuthenticationDisabled: true,
		ResourcePacks:          packs,
		TexturePacksRequired:   true,
		ErrorLog:               s.Logger,
	}.Listen("raknet", s.Listen)
	if err != nil {
		return err
	}
	defer listener.Close()

	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()

	s.Logger.Info("shadow listening", "listen", listener.Addr().String(), "remote", s.RemoteAddress, "packs", len(packs))

	for {
		c, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		client := c.(*minecraft.Conn)
		go s.serve(ctx, client)
	}
}

// probe dials the server once and disconnects.
//
// With local packs set, nothing is downloaded: DownloadResourcePack refuses
// every offer, ResourcePackStack order is still captured, and the local packs
// are what gets ingested and returned for the listener. Without local packs,
// packs are downloaded except ones whose advertised size cannot be allocated.
//
// @param ctx Cancelled to abort the probe. The dial itself is also capped at
// shadowProbeTimeout.
// @returns packs to offer incoming clients.
func (s *Shadow) probe(ctx context.Context) ([]*resource.Pack, error) {
	local, err := s.loadPacks()
	if err != nil {
		return nil, err
	}

	probeName := "probe" + uuid.New().String()[:6]
	dialer := minecraft.Dialer{
		ErrorLog: s.Logger,
		IdentityData: login.IdentityData{
			DisplayName: probeName,
			Identity:    uuid.NewSHA1(uuid.NameSpaceOID, []byte(probeName)).String(),
		},
	}
	assets.WireDialer(&dialer, s.Assets)
	if len(local) > 0 {
		// Refuse every pack. A 264MB transfer (or BDS's ^uint64(0) size) must
		// not run on the probe; the listener serves the local files instead.
		dialer.DownloadResourcePack = func(uuid.UUID, string, int, int) bool { return false }
	} else {
		s.refuseUnsizedPacks(&dialer)
	}

	s.Logger.Info("shadow probe dialing", "address", s.RemoteAddress, "localPacks", len(local))
	probeCtx, cancel := context.WithTimeout(ctx, shadowProbeTimeout)
	defer cancel()
	conn, err := dialer.DialContext(probeCtx, "raknet", s.RemoteAddress)
	if err != nil {
		return nil, probeFailure("dial", err)
	}
	if err := conn.DoSpawnContext(probeCtx); err != nil {
		_ = conn.Close()
		return nil, probeFailure("spawn", err)
	}

	packs := local
	if len(packs) == 0 {
		packs = append([]*resource.Pack(nil), conn.ResourcePacks()...)
	}
	if s.Assets != nil {
		if err := s.Assets.IngestServerPacks(packs); err != nil {
			s.Logger.Error("ingest resource packs", "error", err)
		}
	}
	_ = conn.Close()
	s.Logger.Info("shadow probe finished", "packs", len(packs))
	return packs, nil
}

// loadPacks reads Shadow.Packs with resource.ReadPath.
//
// @returns nil when no local packs are configured.
func (s *Shadow) loadPacks() ([]*resource.Pack, error) {
	if len(s.Packs) == 0 {
		return nil, nil
	}
	out := make([]*resource.Pack, 0, len(s.Packs))
	for _, path := range s.Packs {
		s.Logger.Info("loading shadow pack", "path", path)
		pack, err := readShadowPack(path)
		if err != nil {
			return nil, fmt.Errorf("shadow pack %s: %w", path, err)
		}
		s.Logger.Info("shadow pack loaded", "path", path, "uuid", pack.UUID().String(), "version", pack.Version())
		out = append(out, pack)
	}
	return out, nil
}

// readShadowPack loads a .mcpack/.zip via resource.ReadPath. A directory is
// zipped first, omitting node_modules and .git: ReadPath walks every entry
// and fails on the broken symlinks those trees contain, and they are not
// pack content. The archive is then passed to resource.ReadPath.
func readShadowPack(path string) (*resource.Pack, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return resource.ReadPath(path)
	}
	zipPath, err := zipPackDir(path)
	if err != nil {
		return nil, err
	}
	defer os.Remove(zipPath)
	return resource.ReadPath(zipPath)
}

// zipPackDir writes path to a temp zip and returns that file's path.
func zipPackDir(path string) (string, error) {
	temp, err := os.CreateTemp("", "shadow-pack-*.zip")
	if err != nil {
		return "", err
	}
	zw := zip.NewWriter(temp)
	walkErr := filepath.WalkDir(path, func(filePath string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && (d.Name() == "node_modules" || d.Name() == ".git") {
			return filepath.SkipDir
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(path, filePath)
		if err != nil {
			return err
		}
		rel = strings.ReplaceAll(rel, `\`, "/")
		src, err := os.Open(filePath)
		if err != nil {
			return nil
		}
		defer src.Close()
		dst, err := zw.Create(rel)
		if err != nil {
			return err
		}
		_, err = io.Copy(dst, src)
		return err
	})
	closeErr := zw.Close()
	if err := temp.Close(); err != nil && closeErr == nil {
		closeErr = err
	}
	if walkErr != nil || closeErr != nil {
		_ = os.Remove(temp.Name())
		if walkErr != nil {
			return "", walkErr
		}
		return "", closeErr
	}
	return temp.Name(), nil
}

// refuseUnsizedPacks keeps the downloaded-pack path from allocating or
// requesting a pack whose ResourcePacksInfo size is ^uint64(0). Stack capture
// from WireDialer is left in place.
func (s *Shadow) refuseUnsizedPacks(dialer *minecraft.Dialer) {
	skipPack := map[uuid.UUID]struct{}{}
	prev := dialer.PacketFunc
	innerDownload := dialer.DownloadResourcePack
	dialer.PacketFunc = func(header packet.Header, payload []byte, src, dst net.Addr) {
		if header.PacketID == packet.IDResourcePacksInfo {
			for _, id := range clampUnknownPackSizes(payload) {
				skipPack[id] = struct{}{}
			}
			if len(skipPack) > 0 {
				s.Logger.Info("resource pack size unknown; not downloading", "count", len(skipPack))
			}
		}
		if prev != nil {
			prev(header, payload, src, dst)
		}
	}
	dialer.DownloadResourcePack = func(id uuid.UUID, version string, current, total int) bool {
		if _, skip := skipPack[id]; skip {
			return false
		}
		if innerDownload == nil {
			return false
		}
		return innerDownload(id, version, current, total)
	}
}

// probeFailure turns a deadline into an explicit probe timeout.
func probeFailure(op string, err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("shadow probe timed out after %s during %s", shadowProbeTimeout, op)
	}
	return fmt.Errorf("shadow probe %s: %w", op, err)
}

// serve proxies one accepted client until it disconnects or ctx is cancelled.
//
// @param ctx Parent context. Cancelled to drop this session.
// @param client The real client's connection, already logged in.
func (s *Shadow) serve(ctx context.Context, client *minecraft.Conn) {
	ident := client.IdentityData()
	if ident.DisplayName == "" {
		ident.DisplayName = "Player"
	}
	name := ident.DisplayName
	log := s.Logger.With("player", name)
	log.Info("shadow session")

	if s.Viewer != nil {
		s.Viewer.Register(name)
		defer s.Viewer.Unregister(name)
	}

	dialer := minecraft.Dialer{
		ErrorLog:             log,
		IdentityData:         ident,
		ClientData:           client.ClientData(),
		DownloadResourcePack: func(uuid.UUID, string, int, int) bool { return false },
	}
	server, err := dialer.DialContext(ctx, "raknet", s.RemoteAddress)
	if err != nil {
		log.Error("shadow server dial", "error", err)
		_ = client.Close()
		return
	}

	session, cancel := context.WithCancel(ctx)
	defer cancel()
	defer client.Close()
	defer server.Close()

	data := server.GameData()
	errc := make(chan error, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		errc <- client.StartGame(data)
	}()
	go func() {
		defer wg.Done()
		errc <- server.DoSpawn()
	}()
	wg.Wait()
	close(errc)
	for err := range errc {
		if err != nil {
			log.Error("shadow spawn", "error", err)
			return
		}
	}
	log.Info("shadow spawned")

	test := &Test{
		Dialer:        minecraft.Dialer{IdentityData: ident},
		RemoteAddress: s.RemoteAddress,
		Logger:        log,
		Viewer:        s.Viewer,
	}
	test.prepare()

	tee := newShadowTee(server, client, log)
	err = test.drive(session, tee, sessionOpts{
		passive:        true,
		skipSpawnGrace: true,
		ready: func(b *bot.Bot) {
			go func() {
				if err := pumpClient(client, server, b); err != nil && session.Err() == nil {
					log.Debug("shadow client pump ended", "error", err)
				}
				cancel()
			}()
		},
	})
	if err != nil {
		log.Error("shadow session ended", "error", err)
	}
	log.Info("shadow session closed")
}

// pumpClient forwards every client packet to the server and mirrors the few
// that the passive actor must reflect locally.
//
// @param client The real client's connection.
// @param server The upstream server connection.
// @param b The passive bot. May receive TryExecute calls.
// @returns the read or write error that ended the pump.
func pumpClient(client *minecraft.Conn, server *minecraft.Conn, b *bot.Bot) error {
	for {
		pk, err := client.ReadPacket()
		if err != nil {
			return err
		}
		if err := server.WritePacket(pk); err != nil {
			return err
		}
		mirrorClientPacket(b, pk)
	}
}

// mirrorClientPacket copies client intent the viewer needs and the passive
// actor will not learn from server packets alone.
//
// @param b Passive bot. Work runs on its tick loop via TryExecute.
// @param pk Packet just forwarded to the server.
func mirrorClientPacket(b *bot.Bot, pk packet.Packet) {
	switch pk := pk.(type) {
	case *packet.PlayerAuthInput:
		// Copy scalars: the packet must not be read after ReadPacket returns it
		// to the next call.
		pos := pk.Position
		yaw, pitch := pk.Yaw, pk.Pitch
		b.TryExecute(func(a *actor.Actor) {
			feet := mcmath.Vec32To64(pos).Sub(mgl64.Vec3{0, shadowEyeOffset})
			a.Move(feet, cube.Rotation{float64(yaw), float64(pitch)})
			a.SetChunkLoadCenter(cube.PosFromVec3(feet))
		})
	case *packet.ModalFormResponse:
		b.TryExecute(func(a *actor.Actor) { a.DismissForm() })
	case *packet.ContainerClose:
		b.TryExecute(func(a *actor.Actor) { a.DismissContainer() })
	case *packet.NPCRequest:
		switch pk.RequestType {
		case packet.NPCRequestActionExecuteClosingCommands, packet.NPCRequestActionExecuteAction:
			b.TryExecute(func(a *actor.Actor) { a.DismissDialogue() })
		}
	}
}

// maxPackPrealloc is the largest ResourcePacksInfo size gophertunnel may
// preallocate. Anything larger, including BDS 1.26's ^uint64(0) sentinel, is
// rewritten to 0 and skipped: this server never answers a download request
// for that size, and the raw value panics the prealloc.
const maxPackPrealloc = 512 << 20

// clampUnknownPackSizes rewrites oversized TexturePackInfo.Size fields in a
// ResourcePacksInfo payload in place and returns the UUIDs of those packs.
//
// @param payload Packet body after the header. Mutated when a size is clamped.
// @returns UUIDs whose size was above maxPackPrealloc.
func clampUnknownPackSizes(payload []byte) []uuid.UUID {
	r := newPackReader(payload)
	if !r.skip(4) || !r.skip(16) || !r.skipString() { // flags, template UUID, template version
		return nil
	}
	n, ok := r.varu32()
	if !ok {
		return nil
	}
	var clamped []uuid.UUID
	for range n {
		idOff := r.off()
		if !r.skip(16) || !r.skipString() { // pack UUID, version
			return clamped
		}
		off := r.off()
		size, ok := r.u64()
		if !ok {
			return clamped
		}
		if size > maxPackPrealloc {
			binary.LittleEndian.PutUint64(payload[off:off+8], 0)
			if id, ok := wireUUID(payload[idOff : idOff+16]); ok {
				clamped = append(clamped, id)
			}
		}
		// ContentKey, SubPackName, ContentIdentity, three bools, DownloadURL.
		if !r.skipString() || !r.skipString() || !r.skipString() || !r.skip(3) || !r.skipString() {
			return clamped
		}
	}
	return clamped
}

// packReader walks a little-endian Bedrock packet body. Failures stick so the
// caller can stop without tracking every error.
type packReader struct {
	b   []byte
	i   int
	bad bool
}

func newPackReader(b []byte) *packReader { return &packReader{b: b} }

// wireUUID decodes a Bedrock UUID. The two int64s are little-endian on the wire.
func wireUUID(raw []byte) (uuid.UUID, bool) {
	if len(raw) != 16 {
		return uuid.UUID{}, false
	}
	var b [16]byte
	copy(b[:], raw)
	for i, j := 0, 7; i < j; i, j = i+1, j-1 {
		b[i], b[j] = b[j], b[i]
	}
	for i, j := 8, 15; i < j; i, j = i+1, j-1 {
		b[i], b[j] = b[j], b[i]
	}
	id, err := uuid.FromBytes(b[:])
	return id, err == nil
}

func (r *packReader) off() int { return r.i }

func (r *packReader) skip(n int) bool {
	if r.bad || r.i+n > len(r.b) {
		r.bad = true
		return false
	}
	r.i += n
	return true
}

func (r *packReader) u64() (uint64, bool) {
	if r.bad || r.i+8 > len(r.b) {
		r.bad = true
		return 0, false
	}
	v := binary.LittleEndian.Uint64(r.b[r.i : r.i+8])
	r.i += 8
	return v, true
}

func (r *packReader) varu32() (uint32, bool) {
	if r.bad {
		return 0, false
	}
	var v uint32
	for shift := uint(0); shift < 35; shift += 7 {
		if r.i >= len(r.b) {
			r.bad = true
			return 0, false
		}
		b := r.b[r.i]
		r.i++
		v |= uint32(b&0x7f) << shift
		if b&0x80 == 0 {
			return v, true
		}
	}
	r.bad = true
	return 0, false
}

func (r *packReader) skipString() bool {
	n, ok := r.varu32()
	if !ok {
		return false
	}
	return r.skip(int(n))
}

// shadowSrc is the server side of a tee. *minecraft.Conn implements it.
type shadowSrc interface {
	ReadPacket() (packet.Packet, error)
	IdentityData() login.IdentityData
	GameData() minecraft.GameData
	io.Closer
}

// shadowSink is the real client the tee forwards server packets to.
type shadowSink interface {
	WritePacket(pk packet.Packet) error
	io.Closer
}

// shadowTee implements bot.Conn. ReadPacket forwards the server packet to the
// real client before handing it to the bot. WritePacket drops the bot's own
// output so only the real client drives the server.
type shadowTee struct {
	server shadowSrc
	client shadowSink
	log    *slog.Logger

	dropOnce  sync.Once
	closeOnce sync.Once
}

// newShadowTee builds a tee over a server source and a client sink.
//
// @param server Packets are read from here. Identity and game data come from it.
// @param client Server packets are written here before the bot sees them.
// @param log Receives one debug line the first time a bot write is dropped.
func newShadowTee(server shadowSrc, client shadowSink, log *slog.Logger) *shadowTee {
	return &shadowTee{server: server, client: client, log: log}
}

// ReadPacket reads one server packet, forwards it to the client, then returns it.
//
// @returns the packet the bot should handle, or an error from either side.
func (t *shadowTee) ReadPacket() (packet.Packet, error) {
	pk, err := t.server.ReadPacket()
	if err != nil {
		return nil, err
	}
	if err := t.client.WritePacket(pk); err != nil {
		return nil, err
	}
	return pk, nil
}

// WritePacket drops the packet. The real client drives; the bot is passive.
//
// @param pk Bot output. Not forwarded.
// @returns nil always.
func (t *shadowTee) WritePacket(pk packet.Packet) error {
	t.dropOnce.Do(func() {
		if t.log != nil {
			t.log.Debug("dropping bot write; shadow client drives", "packet", fmt.Sprintf("%T", pk))
		}
	})
	return nil
}

// IdentityData returns the upstream server connection's identity.
func (t *shadowTee) IdentityData() login.IdentityData {
	return t.server.IdentityData()
}

// GameData returns the upstream server connection's game data.
func (t *shadowTee) GameData() minecraft.GameData {
	return t.server.GameData()
}

// Close closes the client and the server connections.
//
// @returns joined errors from both closes. Safe to call more than once.
func (t *shadowTee) Close() error {
	var err error
	t.closeOnce.Do(func() {
		err = errors.Join(t.client.Close(), t.server.Close())
	})
	return err
}

// shadowTee must be usable as a bot connection.
var _ bot.Conn = (*shadowTee)(nil)
