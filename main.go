// Command gotestbds connects headless test clients ("bots") to a Minecraft
// Bedrock Dedicated Server so that a Script API addon can drive them and assert
// against the result.
//
// The bots do not authenticate with Xbox Live, so dial the dedicated server
// directly rather than a proxy that terminates authentication.
package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/FDUTCH/dummy_item_blocks/dummy"
	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
	"github.com/smell-of-curry/go-test-bds/gotestbds"
	"github.com/smell-of-curry/go-test-bds/gotestbds/viewer"
)

// botIdentityNamespace keeps a bot's UUID stable across runs so the server sees
// the same player returning rather than a new one each time. Tests that depend
// on persisted player data need that.
var botIdentityNamespace = uuid.MustParse("6f1c2a94-3d8f-4f2b-9f2c-1a5b7d9e0c31")

func main() {
	config, err := ReadConfig()
	if err != nil {
		slog.Error("reading config", "error", err)
		os.Exit(1)
	}

	// Gives the bots block and item knowledge for identifiers the server has
	// but vanilla dragonfly does not, which makes their actions more accurate.
	dummy.Register()

	var level slog.Level
	if err := level.UnmarshalText([]byte(config.LogLevel)); err != nil {
		slog.Error("invalid log level", "value", config.LogLevel, "error", err)
		os.Exit(1)
	}
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level}))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var hub *viewer.Hub
	if config.Viewer.Enabled {
		var err error
		hub, err = viewer.New(viewer.Options{
			Address:     config.Viewer.Address,
			Radius:      config.Viewer.Radius,
			ArtifactDir: config.Viewer.ArtifactDir,
			AppDir:      config.Viewer.AppDir,
			Logger:      logger.With("src", "viewer"),
		})
		if err != nil {
			slog.Error("starting viewer", "error", err)
			os.Exit(1)
		}
		defer hub.Close()
		logger.Info("viewer listening", "address", hub.Addr())
	}

	logger.Info("starting bots",
		"address", config.Network.ServerAddress,
		"count", config.Bots.Count,
	)

	var (
		wg       sync.WaitGroup
		failures = make(chan error, config.Bots.Count)
	)
	for i := 0; i < config.Bots.Count; i++ {
		name := config.BotName(i)
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := runBot(ctx, config, name, logger, hub); err != nil {
				logger.Error("bot stopped", "bot", name, "error", err)
				failures <- err
			}
		}()
	}
	wg.Wait()
	close(failures)

	// A bot that stops because we asked it to is not a failure.
	if ctx.Err() != nil {
		logger.Info("shut down")
		return
	}
	if len(failures) > 0 {
		os.Exit(1)
	}
}

// runBot connects a single bot and blocks until it disconnects or ctx is done.
//
// @param ctx Cancelled to disconnect the bot.
// @param config The resolved runner configuration.
// @param name The bot's display name.
// @param logger Logger, tagged with the bot's name for this bot's records.
// @returns nil once the bot disconnects cleanly, or the error that stopped it.
func runBot(ctx context.Context, config Config, name string, logger *slog.Logger, hub *viewer.Hub) error {
	test := &gotestbds.Test{
		Dialer: minecraft.Dialer{
			// No TokenSource: these are offline identities. The server must
			// accept unauthenticated clients (BDS `online-mode=false`).
			IdentityData: login.IdentityData{
				DisplayName: name,
				Identity:    uuid.NewSHA1(botIdentityNamespace, []byte(name)).String(),
			},
		},
		RemoteAddress: config.Network.ServerAddress,
		Logger:        logger.With("bot", name),
		Viewer:        hub,
	}

	err := test.RunCtx(ctx)
	if err != nil && errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}
