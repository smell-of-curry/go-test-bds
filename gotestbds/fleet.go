package gotestbds

import (
	"context"
	"encoding/json"
	"sort"
	"sync"
	"time"

	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/instruction"
)

// BotInfo is one row of the control API's bot list.
type BotInfo struct {
	Name   string `json:"name"`
	Online bool   `json:"online"`
}

// Fleet is the set of bots an external controller can drive.
// Nil-safe: methods on a nil Fleet do nothing or report no bots.
type Fleet struct {
	mu   sync.Mutex
	bots map[string]*fleetBot
}

type fleetBot struct {
	name    string
	bot     *bot.Bot
	pull    *instruction.Pull
	closed  <-chan struct{}
	timeout func(ms int) time.Duration
}

// NewFleet returns an empty fleet.
func NewFleet() *Fleet {
	return &Fleet{bots: make(map[string]*fleetBot)}
}

// Add registers a bot. A later Add for the same name replaces it.
// Remove only drops the entry when bot is still the one registered, so a
// rejoin cannot be unregistered by the previous session's cleanup.
func (f *Fleet) Add(name string, b *bot.Bot, pull *instruction.Pull, timeout func(int) time.Duration) {
	if f == nil || b == nil || name == "" {
		return
	}
	if timeout == nil {
		timeout = func(ms int) time.Duration {
			if ms > 0 {
				return time.Duration(ms) * time.Millisecond
			}
			return DefaultInstructionTimeout
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bots[name] = &fleetBot{
		name:    name,
		bot:     b,
		pull:    pull,
		closed:  b.Closed(),
		timeout: timeout,
	}
}

// Remove drops name if it still points at b.
func (f *Fleet) Remove(name string, b *bot.Bot) {
	if f == nil {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	cur, ok := f.bots[name]
	if ok && cur.bot == b {
		delete(f.bots, name)
	}
}

// List returns bots sorted by name.
func (f *Fleet) List() []BotInfo {
	if f == nil {
		return []BotInfo{}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]BotInfo, 0, len(f.bots))
	for _, b := range f.bots {
		out = append(out, BotInfo{Name: b.name, Online: b.online()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (b *fleetBot) online() bool {
	if b == nil || b.closed == nil {
		return false
	}
	select {
	case <-b.closed:
		return false
	default:
		return true
	}
}

// RunResult is the HTTP-facing outcome of one instruction.
type RunResult struct {
	// Code is the HTTP status. Instruction failures are 200 with a status
	// field in Body — the same JSON the chat path would send.
	Code int
	Body []byte
}

// Run dispatches action on name. timeoutMs is the instruction timeout; 0 uses
// the bot's default. id is echoed in the status JSON when non-empty.
func (f *Fleet) Run(ctx context.Context, name, id, action string, params json.RawMessage, timeoutMs int) RunResult {
	if f == nil {
		return errorResult(503, "control disabled")
	}
	f.mu.Lock()
	b := f.bots[name]
	f.mu.Unlock()
	if b == nil {
		return errorResult(404, "unknown bot")
	}
	if !b.online() {
		return errorResult(409, "bot offline")
	}
	timeout := b.timeout(timeoutMs)
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	status, message, data := Dispatch(runCtx, b.pull, b.bot, action, params)
	body, err := MarshalStatusEnvelope(id, status, message, data)
	if err != nil {
		return errorResult(500, err.Error())
	}
	return RunResult{Code: 200, Body: body}
}

func errorResult(code int, message string) RunResult {
	body, _ := MarshalStatusEnvelope("", StatusError, message, nil)
	return RunResult{Code: code, Body: body}
}
