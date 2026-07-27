package instruction

import (
	"context"

	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/viewer"
)

// ViewerMark broadcasts a run-lifecycle mark to every bot stream.
//
// With no viewer configured this succeeds and does nothing — marks must never
// fail a test.
type ViewerMark struct {
	Phase     string `json:"phase"`
	RunID     string `json:"runId"`
	Suite     string `json:"suite"`
	Test      string `json:"test"`
	Status    string `json:"status"`
	Message   string `json:"message"`
	ElapsedMs int64  `json:"elapsedMs"`
	hub       *viewer.Hub
}

// Name returns the instruction name.
func (*ViewerMark) Name() string {
	return "viewerMark"
}

// Run forwards the mark to the hub, or no-ops when none is configured.
func (v *ViewerMark) Run(_ context.Context, _ *bot.Bot) error {
	if v.hub == nil {
		return nil
	}
	v.hub.Mark(viewer.Mark{
		Phase:     v.Phase,
		RunID:     v.RunID,
		Suite:     v.Suite,
		Test:      v.Test,
		Status:    v.Status,
		Message:   v.Message,
		ElapsedMs: v.ElapsedMs,
	})
	return nil
}
