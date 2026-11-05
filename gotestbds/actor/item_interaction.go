package actor

import "fmt"

// ItemInteractionTransport selects the packet carrying air/block item clicks.
// Servers do not advertise this capability consistently, so select it explicitly.
type ItemInteractionTransport string

const (
	ItemInteractionAuthInput            ItemInteractionTransport = "auth-input"
	ItemInteractionInventoryTransaction ItemInteractionTransport = "inventory-transaction"
)

// ParseItemInteractionTransport validates a transport. Empty uses the BDS default.
func ParseItemInteractionTransport(value string) (ItemInteractionTransport, error) {
	switch transport := ItemInteractionTransport(value); transport {
	case "", ItemInteractionAuthInput:
		return ItemInteractionAuthInput, nil
	case ItemInteractionInventoryTransaction:
		return transport, nil
	default:
		return "", fmt.Errorf("invalid item interaction transport %q: want auth-input or inventory-transaction", value)
	}
}

// SetItemInteractionTransport configures a session before sending item input.
// Call before the tick loop, or on its goroutine. Pending actions retain their
// configured transport: changing it while actions are queued is rejected.
func (a *Actor) SetItemInteractionTransport(transport ItemInteractionTransport) error {
	value, err := ParseItemInteractionTransport(string(transport))
	if err != nil {
		return err
	}
	current, _ := ParseItemInteractionTransport(string(a.itemInteractionTransport))
	if value != current && len(a.pendingItemInteractions) > 0 {
		return fmt.Errorf("cannot change item interaction transport while item input is queued")
	}
	a.itemInteractionTransport = value
	return nil
}
