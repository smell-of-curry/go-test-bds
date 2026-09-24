package instruction

import (
	"testing"
)

func TestDismissFormName(t *testing.T) {
	var d DismissForm
	if got := d.Name(); got != "dismissForm" {
		t.Fatalf("Name() = %q, want dismissForm", got)
	}
}
