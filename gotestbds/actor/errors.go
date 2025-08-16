package actor

import (
	"fmt"

	"github.com/df-mc/dragonfly/server/world"
)

// ErrActionCanceled ...
type ErrActionCanceled struct {
	ActionName string
}

// Error ...
func (a ErrActionCanceled) Error() string {
	return fmt.Sprintf("%s canceled", a.ActionName)
}

// ErrToFarAway ...
type ErrToFarAway struct {
	Subject any
}

// Error ...
func (e ErrToFarAway) Error() string {
	switch e.Subject.(type) {
	case world.Entity:
		return "entity is too far away"
	case world.Block:
		return "block is too far away"
	}
	return fmt.Sprintf("%T is too far away", e.Subject)
}

// ErrGamemodeRequired ...
type ErrGamemodeRequired struct {
	Action           string
	RequiredGamemode world.GameMode
}

// Error ...
func (g ErrGamemodeRequired) Error() string {
	return fmt.Sprintf("unable to perform %s action, %T gamemode required", g.Action, g.RequiredGamemode)
}
