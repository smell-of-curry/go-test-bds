package instruction

import (
	"context"
	"fmt"
	"time"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/viewer"
)

// Screenshot asks the attached capture harness for a still of the bot's view.
type Screenshot struct {
	Label     string `json:"label"`
	TimeoutMs int    `json:"timeoutMs"`
	hub       *viewer.Hub
	result    any
}

// Name returns the instruction name.
func (*Screenshot) Name() string {
	return "screenshot"
}

// Run reads the current tick, then blocks outside Execute for the harness frame.
//
// Capture must never run inside Execute: it waits for a rendered tick, and
// Execute serialises the bot loop that produces those ticks — a self-deadlock.
func (s *Screenshot) Run(ctx context.Context, b *bot.Bot) error {
	if s.hub == nil {
		return fmt.Errorf("viewer: no subscriber attached")
	}

	timeoutMs := s.TimeoutMs
	if timeoutMs == 0 {
		timeoutMs = 30000
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	var tick uint64
	var botName string
	if err := execute(b, func(a *actor.Actor) error {
		tick = a.CurrentTick()
		botName = a.Name()
		return nil
	}); err != nil {
		return err
	}

	// Capture blocks until the harness posts a frame at tick >= minTick. It
	// lives outside Execute so the bot tick loop keeps running.
	art, err := s.hub.Capture(ctx, botName, s.Label, tick)
	if err != nil {
		return err
	}
	s.result = map[string]any{
		"path":   art.Path,
		"width":  art.Width,
		"height": art.Height,
		"bytes":  art.Bytes,
		"tick":   art.Tick,
	}
	return nil
}

// Data returns the capture payload from the last successful Run.
func (s *Screenshot) Data() any {
	return s.result
}
