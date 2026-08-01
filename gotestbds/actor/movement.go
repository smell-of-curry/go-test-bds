package actor

import (
	"math"
	"time"

	"github.com/FDUTCH/Pathfinder"
	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/entity/effect"
	"github.com/df-mc/dragonfly/server/event"
	"github.com/df-mc/dragonfly/server/item"
	w "github.com/df-mc/dragonfly/server/world"
	"github.com/go-gl/mathgl/mgl32"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath/physics"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath/physics/movement"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// movementData ...
type movementData struct {
	moving bool
	delta  mgl64.Vec3
	tick   uint64

	sneaking, sprinting, swimming, crawling, gliding, immobile, onGround bool
	movementBitset                                                       protocol.Bitset

	path             *pathfind.Path
	navigationTarget cube.Pos
	// repathCooldown skips FindPath for this many ticks after a re-path.
	// Tick loop is 20 Hz and single-threaded — unthrottled FindPath on every
	// stuck tick stalls the bot.
	repathCooldown int
	// fruitlessRepaths counts consecutive re-paths that made no progress.
	fruitlessRepaths int
	// emptyPathWaits counts ticks spent retrying while the start column is
	// still incomplete (FindPath returns empty against pathSource bedrock).
	emptyPathWaits int

	// Last Navigate / fail-fast diagnostic for the instruction error line.
	navFailDetail         string
	navLastTarget         cube.Pos
	navLastGoal           cube.Pos
	navLastStart          cube.Pos
	navLastPathCount      int
	navLastReached        bool
	navLastMaxVisited     int
	navLastStartState     string
	navLastGoalState      string
	navLastUnknownNear    int
	navLastIncompleteNear int

	// Navigation-window diagnostics for zero-displacement failures.
	navStartedAt       time.Time
	navStartTick       uint64
	navPhysicsSkipped  int // ticks physics gated on missing/incomplete column
	navMoveAttempts    int
	navMoveZero        int // MoveRawInput ran but position unchanged
	navMoveRejected    int // MoveRawInput returned false
	physicsSkipStreak  int // consecutive ticks physics was skipped (any time)

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
	if a.CanSprint() && a.InsideOfWater() {
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

// defaultMovementAttribute is vanilla player movement until UpdateAttributes
// arrives. A zero attribute makes MoveRawInput a no-op, so every navigateToBlock
// fails instantly with "0 blocks of progress" under fail-fast.
const defaultMovementAttribute = 0.1

// Speed returns Actor's speed in blocks per tick.
func (a *Actor) Speed() float64 {
	// https://minecraft.wiki/w/Walking
	mPerSecond := 4.317
	mPerTick := mPerSecond / 20
	// TODO swimming speed.
	attr := a.Attributes().Speed()
	// NaN/Inf fail `attr <= 0` in Go, then poison walk → clampVel zeroes move
	// → fruitless_stuck with a path. Treat non-finite like missing.
	if attr <= 0 || math.IsNaN(attr) || math.IsInf(attr, 0) {
		attr = defaultMovementAttribute
	}
	multiplier := attr * 10
	if !a.OnGround() && a.State().Sprinting() {
		// sprinting does not affect air strafing.
		multiplier /= 1.3
	}
	return mPerTick * multiplier
}

// Jump makes Actor jump.
// for what ever reason it can not jump on the block.
func (a *Actor) Jump() {
	ctx := event.C(a)
	if a.Handler().HandleJump(ctx); ctx.Cancelled() {
		return
	}

	// TODO take into account sprinting.
	if !a.OnGround() {
		return
	}
	vel := a.Velocity()
	jumpVel := 0.52
	if e, ok := a.Effect(effect.JumpBoost); ok {
		jumpVel = jumpVel + float64(e.Level())/10
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
	var moveVector mgl32.Vec2
	pitch := float32(a.Rotation().Pitch())
	yaw := float32(a.Rotation().Yaw())

	if a.moving {
		// Prefer this-tick walk delta. Velocity alone is usually friction-
		// decayed horizontal ~0 after physics, so encoding it made every
		// PlayerAuthInput look idle while Navigate thought it was walking
		// (server Correct then fought the local sim).
		src := a.delta
		if src.LenSqr() < 1e-12 {
			src = a.Velocity()
		}
		rotated := mcmath.RotateVec2(mgl64.Vec2{src.X(), src.Z()}, -a.Rotation().Yaw())
		moveVector = mgl32.Vec2{float32(rotated.X()), float32(rotated.Y())}
	}

	a.fillMovementBitset()
	_ = a.conn.WritePacket(&packet.PlayerAuthInput{
		Pitch:             pitch,
		Yaw:               yaw,
		Position:          mcmath.Vec64To32(a.Position().Add(mgl64.Vec3{0, 1.62})),
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

// tickPhysicsOnly runs gravity/collision without sending AuthInput or clearing
// the walk bitset. Actor.Tick sends movement after navigation so the packet
// includes this tick's MoveRawInput delta.
func (a *Actor) tickPhysicsOnly() {
	// Simulating against a missing OR incomplete column reads air (World.Block),
	// so gravity walks the bot into the void / into solids that appear later.
	// Pathfinding already treats incomplete as bedrock (pathSource) — physics
	// must use the same completeness gate or it freezes/falls while FindPath
	// happily plans.
	if !a.chunkLoaded() {
		a.physicsSkipStreak++
		if a.Navigating() {
			a.navPhysicsSkipped++
		}
		a.SetVelocity(mgl64.Vec3{})
		return
	}
	a.physicsSkipStreak = 0

	physicsTick := a.tickPhysics()
	a.Move(physicsTick.Position(), a.Rotation())

	a.resolveVelocity(physicsTick.Velocity())

	a.onGround = physicsTick.OnGround()
}

// chunkLoaded reports whether the chunk the Actor stands in is ready for physics.
//
// @returns true when the bot's own column is present and ColumnComplete.
func (a *Actor) chunkLoaded() bool {
	return chunkLoadedAt(a.world, a.Position())
}

// chunkLoadedAt reports whether the column containing a position is complete.
//
// Presence alone is not enough: LevelChunk in sub-chunk request mode inserts a
// column that still reads as air until SubChunk responses land. Physics on that
// air voids the bot; pathfinding already refuses incomplete columns.
//
// @param wr The world to look in.
// @param pos The position whose column matters.
// @returns true when that column is ColumnComplete.
func chunkLoadedAt(wr *world.World, pos mgl64.Vec3) bool {
	block := cube.PosFromVec3(pos)
	c, ok := wr.Chunk(w.ChunkPos{int32(block[0] >> 4), int32(block[2] >> 4)})
	return ok && c.State == world.ColumnComplete
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

	if int(a.BreakTime(a.breakingPos)/(time.Millisecond*50)) <= a.breakingTick {
		ctx := event.C(a)
		if a.Handler().HandleBlockBreak(ctx, a.breakingPos, a.world.Block(a.breakingPos)); ctx.Cancelled() {
			goto continueBreaking
		}

		action.Action = protocol.PlayerActionStopBreak
		a.world.SetBlock(a.breakingPos, block.Air{})
		a.finishBreaking()
	}

continueBreaking:
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
	ctx := event.C(a)
	if a.Handler().HandleAbortBreaking(ctx, a.breakingPos); ctx.Cancelled() {
		return
	}
	a.abortBreaking = true
}

// Move directly moves Actor.
func (a *Actor) Move(pos mgl64.Vec3, rot cube.Rotation) {
	ctx := event.C(a)
	if a.Handler().HandleMove(ctx, &rot, &pos); ctx.Cancelled() {
		return
	}

	// Accumulate delta BEFORE updating position. Doing it after made
	// pos.Sub(Position()) always zero, so SendMovement/resolveVelocity never
	// saw walk displacement (PlayerAuthInput looked idle every tick).
	before := a.Position()
	a.Player.Move(pos, rot)
	a.delta = a.delta.Add(pos.Sub(before))
}

// MoveRawInput moves Actor according to Input
// should be called once in the tick.
func (a *Actor) MoveRawInput(input movement.Input, deltaRotation cube.Rotation) bool {
	ctx := event.C(a)
	if a.Handler().HandleInput(ctx, &input); ctx.Cancelled() {
		return false
	}

	if a.moving {
		// cannot handle input twice.
		return false
	}

	a.fillInput(input)
	moveVec := input.MoveVector()
	rotation := a.Rotation().Add(deltaRotation)
	if moveVec.LenSqr() == 0 {
		// just rotating.
		a.Move(a.Position(), rotation)
		return true
	}

	a.moving = true

	var move mgl64.Vec3
	switch {
	case a.Gliding():
		// gliding should be simulated by the physics package.
	case a.Swimming():
		move = a.swim(rotation)
	default:
		move = a.walk(moveVec, rotation)
	}

	newPos := a.moveLimit(move)
	a.Move(newPos, rotation)

	return true
}

// walk makes Actor simulate walking motion.
func (a *Actor) walk(moveVec mgl64.Vec2, rotation cube.Rotation) mgl64.Vec3 {
	// TODO implement 0.5 step.
	moveVec = moveVec.Normalize()
	move := mcmath.RotateVec2(moveVec, rotation.Yaw()).Mul(a.Speed())
	return mgl64.Vec3{move.X(), 0, move.Y()}
}

// swim makes Actor simulate swimming motion.
func (a *Actor) swim(rotation cube.Rotation) mgl64.Vec3 {
	return rotation.Vec3().Mul(a.Speed())
}

// tickPhysics ...
func (a *Actor) tickPhysics() *physics.Movement {
	// TODO implement gliding & swimming simulation.
	return a.mc.TickMovement(a.State().Box(), a.Position(), a.Velocity(), a.Rotation(), a.World())
}

// resolveVelocity ...
func (a *Actor) resolveVelocity(vel mgl64.Vec3) {
	if vel.LenSqr() < a.delta.LenSqr() && a.moving {
		if !a.Gliding() && !a.Swimming() {
			// walking does not affect vertical velocity.
			a.delta[1] = vel.Y()
		}
		a.SetVelocity(a.delta)
	} else {
		a.SetVelocity(vel)
	}
}

// moveLimit ...
func (a *Actor) moveLimit(direction mgl64.Vec3) mgl64.Vec3 {
	dPos, _, _ := physics.CheckCollision(a.World(), a.State().Box(), a.Position(), direction)
	return dPos.Add(a.Position())
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

// clearMovement resets movement.
func (a *Actor) clearMovement() {
	a.moving = false
	a.delta = mgl64.Vec3{}
	a.movementBitset = protocol.NewBitset(packet.PlayerAuthInputBitsetSize)
}
