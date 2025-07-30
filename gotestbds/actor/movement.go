package actor

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/entity/effect"
	"github.com/df-mc/dragonfly/server/item"
	"github.com/go-gl/mathgl/mgl32"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath/physics"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath/physics/movement"
	"time"
)

// movementData ...
type movementData struct {
	moving bool
	delta  mgl64.Vec3
	tick   uint64

	sneaking, sprinting, swimming, crawling, gliding, immobile, onGround bool
	movementBitset                                                       protocol.Bitset

	mc *physics.Computer
}

// CurrentTick returns current tick of the actor
func (a *Actor) CurrentTick() uint64 {
	return a.tick
}

// OnGround ...
func (a *Actor) OnGround() bool {
	return a.onGround
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
	if a.CanSprint() {
		a.movementBitset.Set(packet.InputFlagStartSprinting)
		a.sprinting = true
	}
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
	if a.CanSprint() {
		a.movementBitset.Set(packet.InputFlagStartSwimming)
		a.swimming = true
	}
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
	chest := a.Armour().Chestplate()
	if _, ok := chest.Item().(item.Elytra); !ok || chest.Durability() < 2 {
		return
	}
	a.movementBitset.Set(packet.InputFlagStartGliding)
	a.gliding = true
}

// StopGliding ...
func (a *Actor) StopGliding() {
	a.movementBitset.Set(packet.InputFlagStopGliding)
	a.gliding = false
}

// BreakingBlock ...
func (a *Actor) BreakingBlock() bool {
	return a.breakingBlock
}

// Speed returns Actor's speed in blocks per tick.
func (a *Actor) Speed() float64 {
	// https://minecraft.wiki/w/Walking
	mPerSecond := 4.317
	mPerTick := mPerSecond / 20
	multiplier := a.Attributes().Speed() * 10
	return mPerTick * multiplier
}

// Jump makes Actor jump.
func (a *Actor) Jump() {
	// TODO take into account sprinting.
	if !a.OnGround() {
		return
	}
	vel := a.Velocity()
	jumpVel := 0.42
	if e, ok := a.Effect(effect.JumpBoost); ok {
		jumpVel = +float64(e.Level()) / 10
	}
	vel[1] = jumpVel
	a.SetVelocity(vel)
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
	if a.BreakingBlock() {
		a.movementBitset.Set(packet.InputFlagPerformBlockActions)
	}
}

// SendMovement sends movement to the server.
func (a *Actor) SendMovement() {
	vel := a.Velocity()
	var moveVector mgl32.Vec2
	pitch := float32(a.Rotation().Pitch())
	yaw := float32(a.Rotation().Yaw())

	if a.moving {
		rotated := mcmath.RotateVec2(mgl64.Vec2{vel.X(), vel.Z()}, -a.Rotation().Yaw())
		moveVector = mgl32.Vec2{float32(rotated.X()), float32(rotated.Y())}
	}

	a.fillMovementBitset()
	_ = a.conn.WritePacket(&packet.PlayerAuthInput{
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
		BlockActions:      a.blockActions(),
		CameraOrientation: mcmath.Vec64To32(a.Rotation().Vec3()),
		RawMoveVector:     moveVector,
	})
}

// tickMovement simulates Actor's movement.
func (a *Actor) tickMovement() {
	a.SendMovement()
	movementTick := a.mc.TickMovement(a.State().Box(), a.Position(), a.Velocity(), a.World())
	a.Move(movementTick.Position(), a.Rotation())
	a.SetVelocity(movementTick.Velocity())
	a.onGround = movementTick.OnGround()

	// resetting movementBitset every tick.
	a.movementBitset = protocol.NewBitset(packet.PlayerAuthInputBitsetSize)
	a.tick++
}

// blockActions ...
func (a *Actor) blockActions() []protocol.PlayerBlockAction {
	if !a.breakingBlock {
		return nil
	}

	action := protocol.PlayerBlockAction{
		Action:   protocol.PlayerActionStartBreak,
		BlockPos: protocol.BlockPos{int32(a.breakingPos[0]), int32(a.breakingPos[1]), int32(a.breakingPos[2])},
	}

	if a.breakingTick == 0 {
		action.Action = protocol.PlayerActionCrackBreak
	}
	a.breakingTick++

	if int(a.breakTime(a.breakingPos)/(time.Millisecond*50)) <= a.breakingTick {
		action.Action = protocol.PlayerActionStopBreak
	}

	if a.abortBreaking {
		a.finishBreaking()
		action.Action = protocol.PlayerActionAbortBreak
	}
	return []protocol.PlayerBlockAction{action}
}

// finishBreaking ...
func (a *Actor) finishBreaking() {
	a.breakingTick = 0
	a.breakingBlock = false
	a.abortBreaking = false
}

// AbortBreaking makes Actor cancel block breaking.
func (a *Actor) AbortBreaking() {
	a.abortBreaking = true
}

// Move directly moves Actor.
func (a *Actor) Move(pos mgl64.Vec3, rot cube.Rotation) {
	if pos == a.Position() {
		a.Player.Move(pos, rot)
		return
	}
	a.delta = pos.Sub(a.Position())
}

// MoveRawInput moves Actor according to Input.
func (a *Actor) MoveRawInput(input movement.Input, deltaRotation cube.Rotation) {
	a.fillInput(input)
	moveVec := input.MoveVector()
	rotation := a.Rotation().Add(deltaRotation)
	if moveVec.LenSqr() != 0 {
		a.moving = true
		moveVec = moveVec.Normalize()
		return
	}
	move := mcmath.RotateVec2(moveVec, rotation.Yaw()).Mul(a.Speed())
	dPos, _, _ := physics.CheckCollision(a.World(), a.State().Box(), a.Position(), mgl64.Vec3{move.X(), 0, move.Y()})
	a.Move(dPos.Add(a.Position()), rotation)
}

// fillInput fills input flags into movementBitset.
func (a *Actor) fillInput(input movement.Input) {
	if input.Jump {
		a.Jump()
	}
	if input.Sneak && !a.Sneaking() {
		a.StartSneaking()
	} else if a.Sneaking() {
		a.StopSneaking()
	}
	if input.Forward {
		a.movementBitset.Set(packet.InputFlagUp)
		if input.Right {
			a.movementBitset.Set(packet.InputFlagUpRight)
		}
		if input.Left {
			a.movementBitset.Set(packet.InputFlagUpLeft)
		}
	}
	if input.Right {
		a.movementBitset.Set(packet.InputFlagRight)
	}
	if input.Left {
		a.movementBitset.Set(packet.InputFlagLeft)
	}
	if input.Back {
		a.movementBitset.Set(packet.InputFlagDown)
	}
}
