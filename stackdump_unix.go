//go:build unix

package main

import (
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

// watchStackDump writes a full goroutine dump on SIGUSR1 without killing the
// process. Prefer this over SIGQUIT when diagnosing hangs: the manager's
// 200-line botLog ring truncates SIGQUIT stderr dumps. Ops:
// `kill -USR1 <pid>` then read $GOTESTBDS_STACK_DIR/gotestbds-stacks-*.txt
// (default: os.TempDir()).
func watchStackDump(logger *slog.Logger) {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGUSR1)
	for range ch {
		path := writeStackDump("SIGUSR1")
		if logger != nil {
			logger.Warn("wrote goroutine dump", "signal", "SIGUSR1", "path", path)
		}
	}
}

func writeStackDump(reason string) string {
	dir := os.Getenv("GOTESTBDS_STACK_DIR")
	if dir == "" {
		dir = os.TempDir()
	}
	_ = os.MkdirAll(dir, 0o755)
	path := filepath.Join(dir, fmt.Sprintf("gotestbds-stacks-%d.txt", time.Now().Unix()))
	buf := make([]byte, 1<<24)
	n := runtime.Stack(buf, true)
	header := fmt.Sprintf("gotestbds stack dump reason=%s time=%s\n", reason, time.Now().UTC().Format(time.RFC3339))
	_ = os.WriteFile(path, append([]byte(header), buf[:n]...), 0o644)
	return path
}
