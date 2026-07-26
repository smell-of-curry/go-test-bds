package instruction

import (
	"strings"
	"testing"
)

func TestResolveButtonIndex(t *testing.T) {
	buttons := []string{"§aStart", "Settings", "Quit Game"}

	t.Run("exact match", func(t *testing.T) {
		idx, err := resolveButtonIndex(buttons, "Settings")
		if err != nil || idx != 1 {
			t.Fatalf("idx=%d err=%v", idx, err)
		}
	})

	t.Run("case-insensitive", func(t *testing.T) {
		idx, err := resolveButtonIndex(buttons, "settings")
		if err != nil || idx != 1 {
			t.Fatalf("idx=%d err=%v", idx, err)
		}
	})

	t.Run("substring", func(t *testing.T) {
		idx, err := resolveButtonIndex(buttons, "Quit")
		if err != nil || idx != 2 {
			t.Fatalf("idx=%d err=%v", idx, err)
		}
	})

	t.Run("strips color codes", func(t *testing.T) {
		idx, err := resolveButtonIndex(buttons, "Start")
		if err != nil || idx != 0 {
			t.Fatalf("idx=%d err=%v", idx, err)
		}
		idx, err = resolveButtonIndex(buttons, "§aStart")
		if err != nil || idx != 0 {
			t.Fatalf("idx=%d err=%v", idx, err)
		}
	})

	t.Run("no match lists available", func(t *testing.T) {
		_, err := resolveButtonIndex(buttons, "Nope")
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "available:") {
			t.Fatalf("error should list buttons: %v", err)
		}
		for _, b := range buttons {
			if !strings.Contains(err.Error(), b) {
				t.Fatalf("error missing %q: %v", b, err)
			}
		}
	})
}

func TestStripMinecraftColorCodes(t *testing.T) {
	got := stripMinecraftColorCodes("§l§aHello §rWorld")
	if got != "Hello World" {
		t.Fatalf("got %q", got)
	}
}
