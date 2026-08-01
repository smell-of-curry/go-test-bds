//go:build windows

package main

import "log/slog"

// watchStackDump is a no-op on Windows (no SIGUSR1/SIGQUIT).
func watchStackDump(_ *slog.Logger) {}
