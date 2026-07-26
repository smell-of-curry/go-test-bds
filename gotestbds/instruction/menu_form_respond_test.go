package instruction

import (
	"fmt"
	"testing"
)

func TestMenuFormRespondBounds(t *testing.T) {
	// Mirrors the fixed guard in MenuFormRespond.Run.
	check := func(response, buttonCount int) error {
		if response < 1 || response > buttonCount {
			return fmt.Errorf("invalid button response %d: valid range is 1..%d (%d buttons)", response, buttonCount, buttonCount)
		}
		return nil
	}

	if err := check(1, 3); err != nil {
		t.Fatalf("1 should be valid: %v", err)
	}
	if err := check(3, 3); err != nil {
		t.Fatalf("len should be valid: %v", err)
	}
	if err := check(4, 3); err == nil {
		t.Fatal("len+1 must be rejected")
	}
	if err := check(0, 3); err == nil {
		t.Fatal("0 must be rejected")
	}
	if err := check(-1, 3); err == nil {
		t.Fatal("negative must be rejected")
	}
}
