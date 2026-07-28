package bot

import (
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// chunkHealthWindow is how often the world's load state is worth a look.
const chunkHealthWindow = 2 * time.Second

// chunkHealth reports when the bot is standing in a world it cannot see.
//
// A column arrives in two acts: a LevelChunk that says how many sub-chunks to
// ask for, then the SubChunk responses. Every step in between can fail quietly —
// a request that is never answered, an answer whose result is not a payload, a
// column pruned by the wrong load centre — and the bot carries on reporting a
// position in a world it has no blocks for. Assertions then read air, and the
// viewer renders nothing, with nothing anywhere saying why.
type chunkHealth struct {
	windowStart time.Time
	results     map[byte]int
}

// subChunkResult records the result code of one SubChunk entry.
//
// @param result The protocol result byte from the entry.
func (h *chunkHealth) subChunkResult(result byte) {
	if h.results == nil {
		h.results = make(map[byte]int, 4)
	}
	h.results[result]++
}

// report logs the world's load state once per window while any column is
// incomplete, and stays silent when everything has arrived.
//
// @param log Where to report; nil is tolerated so tests can skip it.
// @param a The actor whose world is inspected.
// @param now The current time, passed in so tests need no clock.
// @returns true when a window closed.
func (h *chunkHealth) report(log *slog.Logger, a *actor.Actor, now time.Time) bool {
	if h.windowStart.IsZero() {
		h.windowStart = now
		return false
	}
	if now.Sub(h.windowStart) < chunkHealthWindow {
		return false
	}
	h.windowStart = now

	var requested, partial, complete int
	for _, col := range a.World().Columns() {
		switch col.State {
		case world.ColumnRequested:
			requested++
		case world.ColumnPartial:
			partial++
		default:
			complete++
		}
	}

	// Nothing to say while the world is whole.
	if log == nil || (requested == 0 && partial == 0 && complete > 0) {
		h.results = nil
		return true
	}

	log.Warn("bot cannot see the world it stands in",
		"requested", requested,
		"partial", partial,
		"complete", complete,
		"pos", a.Position(),
		"loadCenter", a.ChunkLoadCenter(),
		"chunkRadius", a.ChunkRadius(),
		"subChunkResults", formatResults(h.results),
	)
	h.results = nil
	return true
}

// formatResults renders a result histogram in a fixed order, naming the codes
// that actually mean something.
//
// @param results Counts keyed by protocol result byte.
// @returns a stable, readable summary, or "none" when nothing arrived.
func formatResults(results map[byte]int) string {
	if len(results) == 0 {
		return "none"
	}
	keys := make([]int, 0, len(results))
	for k := range results {
		keys = append(keys, int(k))
	}
	sort.Ints(keys)

	out := ""
	for _, k := range keys {
		if out != "" {
			out += ","
		}
		out += fmt.Sprintf("%s=%d", subChunkResultName(byte(k)), results[byte(k)])
	}
	return out
}

// subChunkResultName names a SubChunk result code.
//
// @param result The protocol result byte.
// @returns a short name, or the number when unrecognised.
func subChunkResultName(result byte) string {
	switch result {
	case protocol.SubChunkResultSuccess:
		return "success"
	case protocol.SubChunkResultSuccessAllAir:
		return "allAir"
	case protocol.SubChunkResultChunkNotFound:
		return "chunkNotFound"
	case protocol.SubChunkResultInvalidDimension:
		return "invalidDimension"
	case protocol.SubChunkResultPlayerNotFound:
		return "playerNotFound"
	case protocol.SubChunkResultIndexOutOfBounds:
		return "indexOutOfBounds"
	default:
		return fmt.Sprintf("code%d", result)
	}
}
