package entity

import (
	"github.com/go-gl/mathgl/mgl64"
	"github.com/google/uuid"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// EyeOffset is how far above the feet Bedrock writes a player's position in
// AddPlayer, MovePlayer, and MoveActorAbsolute.
const EyeOffset = 1.62

// Player is an implementation of a player entity. Its position is the feet.
type Player struct {
	*Ent

	nick     string
	id       uuid.UUID
	gamemode int
}

// Name ...
func (p *Player) Name() string {
	return p.nick
}

// UUID ...
func (p *Player) UUID() uuid.UUID {
	return p.id
}

// Gamemode ...
func (p *Player) Gamemode() int {
	return p.gamemode
}

// SetGamemode ...
func (p *Player) SetGamemode(gamemode int) {
	p.gamemode = gamemode
}

// FeetOf converts a wire position for e to its stored position.
func FeetOf(e world.Entity, pos mgl64.Vec3) mgl64.Vec3 {
	if _, ok := e.(*Player); ok {
		return pos.Sub(mgl64.Vec3{0, EyeOffset})
	}
	return pos
}

// Type ...
func (p *Player) Type() string {
	return "minecraft:player"
}
