package instruction

import (
	"context"
	"fmt"
	"strings"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// ClickFormButton presses a menu or modal form button by text or index.
type ClickFormButton struct {
	Text   string `json:"text"`
	Index  int    `json:"index"`
	result any
}

// Name returns the instruction name.
func (*ClickFormButton) Name() string {
	return "clickFormButton"
}

// Run presses the resolved form button.
func (c *ClickFormButton) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		f, ok := a.LastForm()
		if !ok {
			return fmt.Errorf("no open form")
		}

		switch f.Type() {
		case actor.FormTypeMenu:
			buttons, _ := f.MenuFormButtons()
			labels := make([]string, len(buttons))
			for i, btn := range buttons {
				labels[i] = btn.Text()
			}
			idx := c.Index
			if c.Text != "" {
				resolved, err := resolveButtonIndex(labels, c.Text)
				if err != nil {
					return err
				}
				idx = resolved
			}
			if idx < 0 || idx >= len(buttons) {
				return fmt.Errorf("invalid button index %d: valid range is 0..%d (%d buttons: %v)", idx, len(buttons)-1, len(buttons), labels)
			}
			if err := buttons[idx].Press(); err != nil {
				return err
			}
			c.result = map[string]any{"index": idx, "text": buttons[idx].Text()}
			return nil

		case actor.FormTypeModal:
			b1, b2, _ := f.ModalFormButtons()
			labels := []string{b1.Text(), b2.Text()}
			idx := c.Index
			if c.Text != "" {
				resolved, err := resolveButtonIndex(labels, c.Text)
				if err != nil {
					return err
				}
				idx = resolved
			}
			if idx < 0 || idx > 1 {
				return fmt.Errorf("invalid modal button index %d: valid range is 0..1 (buttons: %v)", idx, labels)
			}
			var press *actor.FormButton
			if idx == 0 {
				press = b1
			} else {
				press = b2
			}
			if err := press.Press(); err != nil {
				return err
			}
			c.result = map[string]any{"index": idx, "text": press.Text()}
			return nil

		default:
			return fmt.Errorf("clickFormButton supports menu/modal forms, got %s", f.Type())
		}
	})
}

// Data returns the pressed button payload from the last successful Run.
func (c *ClickFormButton) Data() any {
	return c.result
}

// resolveButtonIndex finds a 0-based button index for text.
// Matching order: exact (case-insensitive, § codes stripped), then substring.
func resolveButtonIndex(buttons []string, text string) (int, error) {
	needle := stripMinecraftColorCodes(text)
	needleLower := strings.ToLower(needle)

	normalized := make([]string, len(buttons))
	for i, b := range buttons {
		normalized[i] = strings.ToLower(stripMinecraftColorCodes(b))
	}

	for i, b := range normalized {
		if b == needleLower {
			return i, nil
		}
	}
	for i, b := range normalized {
		if strings.Contains(b, needleLower) {
			return i, nil
		}
	}
	return -1, fmt.Errorf("no button matching %q; available: %v", text, buttons)
}

// stripMinecraftColorCodes removes Minecraft §x color/formatting codes from s.
func stripMinecraftColorCodes(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	runes := []rune(s)
	for i := 0; i < len(runes); i++ {
		if runes[i] == '§' && i+1 < len(runes) {
			i++
			continue
		}
		b.WriteRune(runes[i])
	}
	return b.String()
}
