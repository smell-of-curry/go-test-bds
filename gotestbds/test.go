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
	// DefaultInstructionTimeout overrides DefaultInstructionTimeout when non-zero.
	DefaultInstructionTimeout time.Duration
	// Viewer is the optional process-wide state-export hub. Nil means the
	// viewer is disabled — a run must behave identically either way.
	Viewer *viewer.Hub
	rejoin bool
}

// Run runs test.
func (t *Test) Run() error {
	return t.RunCtx(context.Background())
}

// RunCtx runs text with context.
func (t *Test) RunCtx(ctx context.Context) error {
	// resetting rejoin value.
	t.rejoin = false
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
	}

	b := bot.NewBot(conn, t.Logger.With("src", "bot"))
	if t.Viewer != nil {
		name := t.Dialer.IdentityData.DisplayName
		defer t.Viewer.Unregister(name)
	}
	h := NewTestingHandler(b, t)
	b.Execute(func(a *actor.Actor) {
		a.Handle(h)
	})

	// without this delay BDS won't let Actor move.
	time.Sleep(time.Second * 2)

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

	if t.rejoin {
		// rejoining...
		return t.RunCtx(ctx)
	}
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
