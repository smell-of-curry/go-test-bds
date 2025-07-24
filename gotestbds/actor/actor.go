package actor

import "github.com/smell-of-curry/go-test-bds/gotestbds/world"

// Actor simulates client actions.
type Actor struct {
	conn PacketWriter

	world *world.World
}

// NewActor ...
func NewActor(conn PacketWriter) *Actor {
	return &Actor{conn: conn}
}

// Close ...
func (a *Actor) Close() error {
	// TODO...
	return nil
}

// Tick - simulates client tick.
func (a *Actor) Tick() {

}
