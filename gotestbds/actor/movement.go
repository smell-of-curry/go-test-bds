package actor

import (
	"github.com/go-gl/mathgl/mgl32"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath/physics"
)

// movementData ...
type movementData struct {
	moving bool
	delta  mgl64.Vec3
	tick   uint64

	sneaking, sprinting, swimming, crawling, gliding, immobile bool
	movementBitset                                             protocol.Bitset

	computer *physics.Computer
}

// Sneaking ...
func (m *movementData) Sneaking() bool {
	return m.sneaking
}

// StartSneaking ...
func (m *movementData) StartSneaking() {
	m.movementBitset.Set(packet.InputFlagStartSneaking)
	m.sneaking = true
}

// StopSneaking ...
func (m *movementData) StopSneaking() {
	m.movementBitset.Set(packet.InputFlagStopSneaking)
	m.sneaking = false
}

// Sprinting ...
func (m *movementData) Sprinting() bool {
	return m.sprinting
}

// StartSprinting ...
func (m *movementData) StartSprinting() {
	m.movementBitset.Set(packet.InputFlagStartSprinting)
	m.sprinting = true
}

// StopSprinting ...
func (m *movementData) StopSprinting() {
	m.movementBitset.Set(packet.InputFlagStopSprinting)
	m.sprinting = false
}

// Swimming ...
func (m *movementData) Swimming() bool {
	return m.swimming
}

// StartSwimming ...
func (m *movementData) StartSwimming() {
	m.movementBitset.Set(packet.InputFlagStartSwimming)
	m.swimming = true
}

// StopSwimming ...
func (m *movementData) StopSwimming() {
	m.movementBitset.Set(packet.InputFlagStopSprinting)
	m.swimming = false
}

// Crawling ...
func (m *movementData) Crawling() bool {
	return m.crawling
}

// StartCrawling ...
func (m *movementData) StartCrawling() {
	m.movementBitset.Set(packet.InputFlagStartCrawling)
	m.crawling = true
}

// StopCrawling ...
func (m *movementData) StopCrawling() {
	m.movementBitset.Set(packet.InputFlagStopCrawling)
	m.crawling = false
}

// Gliding ...
func (m *movementData) Gliding() bool {
	return m.gliding
}

// StartGliding ...
func (m *movementData) StartGliding() {
	m.movementBitset.Set(packet.InputFlagStartGliding)
	m.gliding = true
}

// StopGliding ...
func (m *movementData) StopGliding() {
	m.movementBitset.Set(packet.InputFlagStopGliding)
	m.gliding = false
}

// Immobile ...
func (m *movementData) Immobile() bool {
	return m.immobile
}

// fillMovementBitset ...
func (a *Actor) fillMovementBitset() {
	if a.Sneaking() {
		a.movementBitset.Set(packet.InputFlagSneaking)
	}
	if a.Sprinting() {
		a.movementBitset.Set(packet.InputFlagSprinting)
	}
}

// SendMovement sends movement to the server.
func (a *Actor) SendMovement() {
	vel := a.Velocity()
	var moveVector mgl32.Vec2
	pitch := float32(a.Rotation().Pitch())
	yaw := float32(a.Rotation().Yaw())

	if !a.moving {
		moveVector = mcmath.RotateVec2(mgl32.Vec2{float32(vel.X()), float32(vel.Z())}, -yaw)
	}

	a.fillMovementBitset()
	a.conn.WritePacket(&packet.PlayerAuthInput{
		Pitch:             pitch,
		Yaw:               yaw,
		Position:          mcmath.Vec64To32(a.Position()),
		MoveVector:        moveVector.Normalize(),
		HeadYaw:           yaw,
		InputData:         a.movementBitset,
		InputMode:         packet.InputModeTouch,
		InteractionModel:  packet.InteractionModelTouch,
		InteractPitch:     pitch,
		InteractYaw:       yaw,
		Tick:              a.tick,
		Delta:             mcmath.Vec64To32(a.delta),
		CameraOrientation: mcmath.Vec64To32(a.Rotation().Vec3()),
		RawMoveVector:     moveVector,
	})
}

// tickMovement simulates Actor's movement.
func (a *Actor) tickMovement() {
	a.SendMovement()
	movement := a.computer.TickMovement(a.State().Box(), a.Position(), a.Velocity(), a.World())
	a.Move(movement.Position(), a.Rotation())
	a.SetVelocity(movement.Velocity())
	a.tick++
}
