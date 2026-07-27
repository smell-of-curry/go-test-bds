package instruction

import (
	"context"

	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/viewer"
)

// PullArtifacts drains artefacts written since the last pull.
type PullArtifacts struct {
	hub    *viewer.Hub
	result any
}

// Name returns the instruction name.
func (*PullArtifacts) Name() string {
	return "pullArtifacts"
}

// Run returns artefacts from the hub, or an empty list when none is configured.
func (p *PullArtifacts) Run(_ context.Context, _ *bot.Bot) error {
	arts := []viewer.Artifact{}
	if p.hub != nil {
		if pulled := p.hub.PullArtifacts(); pulled != nil {
			arts = pulled
		}
	}
	p.result = map[string]any{"artifacts": arts}
	return nil
}

// Data returns the artefacts payload from the last successful Run.
func (p *PullArtifacts) Data() any {
	return p.result
}
