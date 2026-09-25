package inventory

import (
	"testing"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
)

// TestItemInstanceKeepsUnknownNetworkID covers a custom item the bot's item
// table has never heard of. Decoding it yields air, and sending that air as
// the held stack makes BDS drop the use-on-block.
func TestItemInstanceKeepsUnknownNetworkID(t *testing.T) {
	h := NewHandle(9, 0, nil)
	const (
		networkID int32 = 9001
		stackID   int32 = 42
	)
	err := h.SetItem(0, protocol.ItemInstance{
		StackNetworkID: stackID,
		Stack: protocol.ItemStack{
			ItemType: protocol.ItemType{NetworkID: networkID},
			Count:    1,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := h.ItemInstance(0)
	if err != nil {
		t.Fatal(err)
	}
	if got.Stack.ItemType.NetworkID != networkID {
		t.Fatalf("network id = %d, want %d", got.Stack.ItemType.NetworkID, networkID)
	}
	if got.StackNetworkID != stackID {
		t.Fatalf("stack id = %d, want %d", got.StackNetworkID, stackID)
	}
	if got.Stack.Count != 1 {
		t.Fatalf("count = %d", got.Stack.Count)
	}
}
