package entity

import (
	"github.com/google/uuid"
)

// Player is an implementation of a player entity.
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

// Type ...
func (p *Player) Type() string {
	return "minecraft:player"
}
