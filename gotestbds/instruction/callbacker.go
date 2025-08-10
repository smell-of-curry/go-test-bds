package instruction

// Callbacker adds a way to set callbacks for sertan actions.
type Callbacker interface {
	SetBreakingCallback(callback func(bool))
	SetNavigationCallback(callback func(bool))
}

// NopCallbacker ...
type NopCallbacker struct{}

// SetBreakingCallback ...
func (NopCallbacker) SetBreakingCallback(callback func(bool)) {}

// SetNavigationCallback ...
func (NopCallbacker) SetNavigationCallback(callback func(bool)) {}
