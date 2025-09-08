package instruction

// Callbacker adds a way to set callbacks for certain actions.
type Callbacker interface {
	SetBreakingCallback(callback func(bool))
	SetNavigationCallback(callback func(bool))
}

// NopCallbacker is a callbacker that does nothing.
type NopCallbacker struct{}

// SetBreakingCallback is a function that sets a breaking callback.
func (NopCallbacker) SetBreakingCallback(callback func(bool)) {}

// SetNavigationCallback is a function that sets a navigation callback.
func (NopCallbacker) SetNavigationCallback(callback func(bool)) {}
