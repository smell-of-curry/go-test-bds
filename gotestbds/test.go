package gotestbds

import (
	"context"
	"log/slog"
	"time"

	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/instruction"
	"github.com/smell-of-curry/go-test-bds/gotestbds/viewer"
)

// Test allows specifying specific settings for testing on the Minecraft server.
// For optimal results, adjust the movement correction and block breaking settings on the server to be as mild as possible.
type Test struct {
	Dialer            minecraft.Dialer
	RemoteAddress     string
	Logger            *slog.Logger
	Instructions      *instruction.Pull
	InstructionPrefix string
	// ItemInteractionTransport selects air/block click encoding. Empty defaults
	// to auth-input for BDS; legacy servers may need inventory-transaction.
	ItemInteractionTransport actor.ItemInteractionTransport
	// DefaultInstructionTimeout overrides DefaultInstructionTimeout when non-zero.
	DefaultInstructionTimeout time.Duration
	// Viewer is the optional process-wide state-export hub. Nil means the
	// viewer is disabled — a run must behave identically either way.
	Viewer *viewer.Hub
	// Fleet is the optional external-control registry. Nil when control is off.
	Fleet  *Fleet
	rejoin bool
}

// InstructionTimeout resolves the effective timeout for an action.
func (t *Test) InstructionTimeout(timeoutMs int) time.Duration {
	timeout := DefaultInstructionTimeout
	if t != nil && t.DefaultInstructionTimeout > 0 {
		timeout = t.DefaultInstructionTimeout
	}
	if timeoutMs > 0 {
		timeout = time.Duration(timeoutMs) * time.Millisecond
	}
	return timeout
}
func (t *Test) Run() error {
	return t.RunCtx(context.Background())
}

// sessionOpts tunes drive. The zero value is a normal bot session.
type sessionOpts struct {
	// passive skips local physics and outbound movement. Shadow mode sets this
	// so the actor follows the real client instead of simulating its own walk.
	passive bool
	// skipSpawnGrace skips the post-spawn pause normal bots need before BDS
	// accepts movement. Shadow must read packets immediately or the real
	// client stalls behind an unread server connection.
	skipSpawnGrace bool
	// ready runs once the bot exists, before the tick loop blocks.
	ready func(*bot.Bot)
}

// RunCtx runs text with context.
func (t *Test) RunCtx(ctx context.Context) error {
	if _, err := actor.ParseItemInteractionTransport(string(t.ItemInteractionTransport)); err != nil {
		return err
	}
	// resetting rejoin value.
	t.rejoin = false
	t.prepare()

	// Register the stream before dial/spawn. The capture harness starts as soon
	// as BDS `list` shows the bot, which is before pack ingest finishes —
	// delaying Register until NewTestingHandler raced the harness into a
	// /stream 404 (unknown bot) and killed capture for the whole run.
	botName := t.Dialer.IdentityData.DisplayName
	if t.Viewer != nil && botName != "" {
		t.Viewer.Register(botName)
		defer t.Viewer.Unregister(botName)
	}

	t.Logger.Debug("dialing", "address", t.RemoteAddress)
	conn, err := t.Dialer.DialContext(ctx, "raknet", t.RemoteAddress)
	if err != nil {
		return err
	}
	t.Logger.Debug("connected", "address", t.RemoteAddress)

	err = conn.DoSpawn()
	if err != nil {
		return err
	}
	t.Logger.Debug("spawned", "address", t.RemoteAddress)

	// Ingest the server's resource pack stack into the viewer asset manager.
	// DownloadResourcePack already gated acceptance; ResourcePacks() holds
	// what arrived, and the stack order was captured via PacketFunc.
	if t.Viewer != nil {
		if mgr := t.Viewer.Assets(); mgr != nil {
			if err := mgr.IngestServerPacks(conn.ResourcePacks()); err != nil {
				t.Logger.Error("ingest resource packs", "error", err)
			}
		}
		t.Viewer.WriteRecordingMeta()
	}

	if err := t.drive(ctx, conn, sessionOpts{}); err != nil {
		return err
	}
	if t.rejoin {
		// rejoining...
		return t.RunCtx(ctx)
	}
	return nil
}

// prepare fills logger, instruction pull, and prefix defaults.
func (t *Test) prepare() {
	if t.Logger == nil {
		t.Logger = slog.Default()
	}
	if t.Instructions == nil {
		t.Instructions = instruction.DefaultPull(nil)
	}
	if t.Viewer != nil {
		instruction.RegisterViewer(t.Instructions, t.Viewer)
	}
	if t.InstructionPrefix == "" {
		t.InstructionPrefix = DefaultInstructionPrefix
	}
}

// drive runs the bot on an already-spawned connection until it stops.
//
// @param ctx Cancelled to close the bot.
// @param conn Spawned server connection. Closed when the tick loop exits.
// @param opts Passive and spawn-grace knobs. Zero value matches a normal bot.
// @returns nil when the tick loop stops. Rejoin is handled by RunCtx.
func (t *Test) drive(ctx context.Context, conn bot.Conn, opts sessionOpts) error {
	transport, err := actor.ParseItemInteractionTransport(string(t.ItemInteractionTransport))
	if err != nil {
		_ = conn.Close()
		return err
	}
	b := bot.NewBot(conn, t.Logger.With("src", "bot"))
	// Validated before constructing the bot; no actions are queued yet.
	_ = b.SetItemInteractionTransport(transport)
	if opts.passive {
		b.SetPassive(true)
	}
	// Before the loop: the first tick must already export to the viewer.
	// Execute would race that tick and drop the opening snapshots.
	b.SetHandler(NewTestingHandler(b, t))
	if opts.ready != nil {
		opts.ready(b)
	}
	if t.Fleet != nil {
		botName := conn.IdentityData().DisplayName
		t.Fleet.Add(botName, b, t.Instructions, t.InstructionTimeout)
		defer t.Fleet.Remove(botName, b)
	}

	// without this delay BDS won't let Actor move.
	if !opts.skipSpawnGrace {
		time.Sleep(time.Second * 2)
	}

	// The tick loop only stops when the bot is closed, so cancellation has to
	// close it: without this the bot ignored SIGTERM, outlived whatever spawned
	// it, and left the server holding a session that refused the next run's
	// login as a duplicate identity.
	stopped := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = b.Close()
		case <-stopped:
		}
	}()

	b.StartTickLoop()
	close(stopped)
	return nil
}

// RunTest ...
func RunTest(addr string) error {
	t := Test{RemoteAddress: addr}
	return t.Run()
}

// RunTestCtx ...
func RunTestCtx(ctx context.Context, addr string) error {
	t := Test{RemoteAddress: addr}
	return t.RunCtx(ctx)
}
