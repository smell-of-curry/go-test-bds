package actor

// Actor simulates client actions.
type Actor struct {
	conn PacketWriter
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
