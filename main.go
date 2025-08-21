package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/FDUTCH/dummy_item_blocks/dummy"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/smell-of-curry/go-test-bds/gotestbds"
)

func main() {
	config, err := ReadConfig()
	if err != nil {
		panic(err)
	}

	// This is recommended so that the bot has more information about the blocks, making its actions more accurate.
	dummy.Register()

	var logLevel slog.Level
	logLevel.UnmarshalText([]byte(config.Network.LogLevel))

	err = (&gotestbds.Test{
		Dialer: minecraft.Dialer{
			// TODO: Handle Token Source handling through config.toml
			// TokenSource: auth.TokenSource,
		},
		RemoteAddress: config.Network.ServerAddress,
		Logger: slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
			Level: logLevel,
		})),
	}).RunCtx(context.Background())

	if err != nil {
		panic(err)
	}
}
