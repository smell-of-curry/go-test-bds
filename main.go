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
	"path/filepath"
	"sync"
	"syscall"

	"github.com/FDUTCH/dummy_item_blocks/dummy"
	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
	"github.com/smell-of-curry/go-test-bds/gotestbds"
	"github.com/smell-of-curry/go-test-bds/gotestbds/assets"
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
		cacheDir := config.Viewer.CacheDir
		if cacheDir == "" {
			cacheDir = filepath.Join(config.Viewer.ArtifactDir, ".cache")
		}
		baselineTag := config.Viewer.BaselineTag
		if baselineTag == "" {
			if pin, err := assets.ReadPinFile(filepath.Join("viewer", "baseline.tag")); err == nil {
				baselineTag = pin
			} else {
				baselineTag = assets.DefaultBaselineTag
			}
		}
		// Assets are what make the render faithful, not what makes the run
		// valid: a missing baseline or a blocked network must cost textures,
		// never a verdict. The viewer carries on with placeholder geometry and
		// says so, loudly enough to act on.
		assetM, err := assets.New(ctx, assets.Options{
			CacheDir:              cacheDir,
			BaselineTag:           baselineTag,
			AcceptServerPacks:     config.Viewer.AcceptServerPacks,
			Offline:               config.Viewer.Offline,
			MemoryPerformanceTier: config.Viewer.MemoryPerformanceTier,
			Logger:                logger.With("src", "assets"),
		})
		if err != nil {
			logger.Error("viewer assets unavailable; rendering placeholders",
				"error", err, "cache", cacheDir, "baseline", baselineTag)
			assetM = nil
		}
		hub, err = viewer.New(viewer.Options{
			Address:       config.Viewer.Address,
			Radius:        config.Viewer.Radius,
			SectionRadius: config.Viewer.SectionRadius,
			ColumnBudget:  config.Viewer.ColumnBudget,
			ArtifactDir:   config.Viewer.ArtifactDir,
			AppDir:        config.Viewer.AppDir,
			Assets:        assetM,
			Logger:        logger.With("src", "viewer"),
		})
		if err != nil {
			slog.Error("starting viewer", "error", err)
			os.Exit(1)
		}
		defer hub.Close()
		logger.Info("viewer listening", "address", hub.Addr(), "cache", cacheDir, "baseline", baselineTag)
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
	dialer := minecraft.Dialer{
		// No TokenSource: these are offline identities. The server must
		// accept unauthenticated clients (BDS `online-mode=false`).
		IdentityData: login.IdentityData{
			DisplayName: name,
			Identity:    uuid.NewSHA1(botIdentityNamespace, []byte(name)).String(),
		},
	}
	// Pack download is gated on the asset manager: nil manager (viewer off)
	// refuses every pack so a normal test run never pulls hundreds of MB.
	var assetM *assets.Manager
	if hub != nil {
		assetM = hub.Assets()
	}
	assets.WireDialer(&dialer, assetM)

	test := &gotestbds.Test{
		Dialer:        dialer,
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
