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

	mc *physics.Computer
}

// Sneaking ...
func (a *Actor) Sneaking() bool {
	return a.sneaking
}

// StartSneaking ...
func (a *Actor) StartSneaking() {
	a.movementBitset.Set(packet.InputFlagStartSneaking)
	a.sneaking = true
}

// StopSneaking ...
func (a *Actor) StopSneaking() {
	a.movementBitset.Set(packet.InputFlagStopSneaking)
	a.sneaking = false
}

// Sprinting ...
func (a *Actor) Sprinting() bool {
	return a.sprinting
}

// StartSprinting ...
func (a *Actor) StartSprinting() {
	a.movementBitset.Set(packet.InputFlagStartSprinting)
	a.sprinting = true
}

// StopSprinting ...
func (a *Actor) StopSprinting() {
	a.movementBitset.Set(packet.InputFlagStopSprinting)
	a.sprinting = false
}

// Swimming ...
func (a *Actor) Swimming() bool {
	return a.swimming
}

// StartSwimming ...
func (a *Actor) StartSwimming() {
	a.movementBitset.Set(packet.InputFlagStartSwimming)
	a.swimming = true
}

// StopSwimming ...
func (a *Actor) StopSwimming() {
	a.movementBitset.Set(packet.InputFlagStopSwimming)
	a.swimming = false
}

// Crawling ...
func (a *Actor) Crawling() bool {
	return a.crawling
}

// StartCrawling ...
func (a *Actor) StartCrawling() {
	a.movementBitset.Set(packet.InputFlagStartCrawling)
	a.crawling = true
}

// StopCrawling ...
func (a *Actor) StopCrawling() {
	a.movementBitset.Set(packet.InputFlagStopCrawling)
	a.crawling = false
}

// Gliding ...
func (a *Actor) Gliding() bool {
	return a.gliding
}

// StartGliding ...
func (a *Actor) StartGliding() {
	a.movementBitset.Set(packet.InputFlagStartGliding)
	a.gliding = true
}

// StopGliding ...
func (a *Actor) StopGliding() {
	a.movementBitset.Set(packet.InputFlagStopGliding)
	a.gliding = false
}

// Immobile ...
func (a *Actor) Immobile() bool {
	return a.immobile
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
	movement := a.mc.TickMovement(a.State().Box(), a.Position(), a.Velocity(), a.World())
	a.Move(movement.Position(), a.Rotation())
	a.SetVelocity(movement.Velocity())
	a.tick++
}
