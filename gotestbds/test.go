package gotestbds

import (
	"context"
	"log/slog"
	"time"

	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/instruction"
)

// Test allows specifying specific settings for testing on the Minecraft server.
// For optimal results, adjust the movement correction and block breaking settings on the server to be as mild as possible.
type Test struct {
	Dialer        minecraft.Dialer
	RemoteAddress string
	Logger        *slog.Logger
	Instructions  *instruction.Pull
}

// Run runs test.
func (t Test) Run() error {
	return t.RunCtx(context.Background())
}

// RunCtx runs text with context.
func (t Test) RunCtx(ctx context.Context) error {
	if t.Logger == nil {
		t.Logger = slog.Default()
	}

	if t.Instructions == nil {
		t.Instructions = instruction.DefaultPull(nil)
	}

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

	b := bot.NewBot(conn, t.Logger.With("src", "bot"))
	h := NewTestingHandler(t.Instructions, b, t.Logger.With("src", "testing"))
	b.Execute(func(a *actor.Actor) {
		a.Handle(h)
	})

	// without this delay BDS won't let Actor move.
	time.Sleep(time.Second * 2)
	b.StartTickLoop()
	return nil
}

// RunTest ...
func RunTest(addr string) error {
	return Test{RemoteAddress: addr}.Run()
}

// RunTestCtx ...
func RunTestCtx(ctx context.Context, addr string) error {
	return Test{RemoteAddress: addr}.RunCtx(ctx)
}
