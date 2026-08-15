package instruction

import (
	"testing"
	"time"
)

// TestNavigationCallbackNeverBlocks guards the run-32 deadlock: the navigation
// callback fires on the bot's tick loop, and when NavigateToBlock.Run has
// already returned (ctx timeout queued a StopNavigating), there is no reader
// left. A blocking send there froze the entire tick loop; the callback must
// absorb the result instead.
func TestNavigationCallbackNeverBlocks(t *testing.T) {
	ch := make(chan bool, 1)
	cb := navigationCallback(ch)

	done := make(chan struct{})
	go func() {
		cb(false) // fills the buffer (no reader, like a returned Run)
		cb(true)  // must not block even with the buffer full
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("navigation callback blocked with no reader — tick-loop deadlock regression")
	}

	// The first result is preserved for a reader that shows up late.
	if got := <-ch; got != false {
		t.Fatalf("buffered result = %v, want false (first fire wins)", got)
	}
}
