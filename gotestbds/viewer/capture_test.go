package viewer

import (
	"context"
	"strings"
	"testing"
	"time"
)

// TestCaptureNoSubscriberFailsFast pins the invariant that asking for a frame
// with nobody rendering errors immediately rather than waiting on a deadline.
func TestCaptureNoSubscriberFailsFast(t *testing.T) {
	hub, err := New(Options{Address: "127.0.0.1:0", ArtifactDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	hub.Register("TestBot")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	start := time.Now()
	_, err = hub.Capture(ctx, "TestBot", "label", 0)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "no subscriber attached") {
		t.Fatalf("error=%v", err)
	}
	if elapsed > 200*time.Millisecond {
		t.Fatalf("Capture took %v; must fail immediately, not wait on ctx", elapsed)
	}
}
