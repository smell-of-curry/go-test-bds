package actor

// NewActor ...
func NewActor(conn PacketWriter) *Actor {
	return &Actor{conn: conn}
}

// Actor simulates client actions.
type Actor struct {
	conn PacketWriter
}

// Close ...
func (a *Actor) Close() error {
	// TODO...
	return nil
}

// Tick - simulates client tick.
func (a *Actor) Tick() {

}
