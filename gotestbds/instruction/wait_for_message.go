package instruction

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// WaitForMessage blocks until a received message matches contains and/or regex.
type WaitForMessage struct {
	Contains  string `json:"contains"`
	Regex     string `json:"regex"`
	TimeoutMs int    `json:"timeoutMs"`
	result    any
}

// Name returns the instruction name.
func (*WaitForMessage) Name() string {
	return "waitForMessage"
}

// Run waits for a matching message, checking the existing buffer first.
func (w *WaitForMessage) Run(ctx context.Context, b *bot.Bot) error {
	if w.Contains == "" && w.Regex == "" {
		return fmt.Errorf("waitForMessage requires contains and/or regex")
	}
	var re *regexp.Regexp
	if w.Regex != "" {
		compiled, err := regexp.Compile(w.Regex)
		if err != nil {
			return fmt.Errorf("invalid regex %q: %w", w.Regex, err)
		}
		re = compiled
	}

	if w.TimeoutMs > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(w.TimeoutMs)*time.Millisecond)
		defer cancel()
	}

	var startSeq uint64
	var matched *actor.ReceivedMessage
	if err := execute(b, func(a *actor.Actor) error {
		// Check the existing buffer first so a just-arrived message is not missed.
		for _, msg := range a.RecentMessages(0) {
			if messageMatches(msg.Text, w.Contains, re) {
				m := msg
				matched = &m
				return nil
			}
		}
		startSeq = a.MessageSeq()
		return nil
	}); err != nil {
		return err
	}
	if matched != nil {
		w.result = map[string]any{
			"message":      matched.Text,
			"receivedAtMs": matched.ReceivedAtMs,
		}
		return nil
	}

	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()

	for {
		matched = nil
		if err := execute(b, func(a *actor.Actor) error {
			for _, msg := range a.MessagesFromSeq(startSeq) {
				if messageMatches(msg.Text, w.Contains, re) {
					m := msg
					matched = &m
					return nil
				}
			}
			return nil
		}); err != nil {
			return err
		}
		if matched != nil {
			w.result = map[string]any{
				"message":      matched.Text,
				"receivedAtMs": matched.ReceivedAtMs,
			}
			return nil
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("timed out waiting for message (contains=%q regex=%q): %w", w.Contains, w.Regex, ctx.Err())
		case <-ticker.C:
		}
	}
}

// Data returns the matched message payload from the last successful Run.
func (w *WaitForMessage) Data() any {
	return w.result
}

// messageMatches reports whether text matches the contains substring and/or regex.
// contains is case-insensitive. When both are set, both must match.
func messageMatches(text, contains string, re *regexp.Regexp) bool {
	if contains != "" && !strings.Contains(strings.ToLower(text), strings.ToLower(contains)) {
		return false
	}
	if re != nil && !re.MatchString(text) {
		return false
	}
	return contains != "" || re != nil
}
