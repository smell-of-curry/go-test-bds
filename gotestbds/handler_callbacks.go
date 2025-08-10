package gotestbds

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	w "github.com/df-mc/dragonfly/server/world"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// callbacks allows instruction to await for certain action to accomplish.
type callbacks struct {
	breakingCallback   func(bool)
	navigatingCallback func(bool)
}

// HandleBlockBreak ...
func (h *TestingHandler) HandleBlockBreak(ctx *actor.Context, pos cube.Pos, block w.Block) {
	if h.breakingCallback != nil {
		h.breakingCallback(true)
		h.breakingCallback = nil
	}
}

// HandleAbortBreaking ...
func (h *TestingHandler) HandleAbortBreaking(ctx *actor.Context, pos cube.Pos) {
	if h.breakingCallback != nil {
		h.breakingCallback(false)
		h.breakingCallback = nil
	}
}

// HandleReachTarget ...
func (h *TestingHandler) HandleReachTarget(actor *actor.Actor) {
	if h.navigatingCallback != nil {
		h.navigatingCallback(true)
		h.navigatingCallback = nil
	}
}

// HandleStopNavigation ...
func (h *TestingHandler) HandleStopNavigation(actor *actor.Actor) {
	if h.navigatingCallback != nil {
		h.navigatingCallback(false)
		h.navigatingCallback = nil
	}
}

// SetBreakingCallback ...
func (h *TestingHandler) SetBreakingCallback(callback func(bool)) {
	h.breakingCallback = callback
}

// SetNavigationCallback ...
func (h *TestingHandler) SetNavigationCallback(callback func(bool)) {
	h.navigatingCallback = callback
}
