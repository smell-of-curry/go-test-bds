package physics

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/go-gl/mathgl/mgl64"
	"math"
)

type Movement struct {
	pos, vel, dpos, dvel mgl64.Vec3
	onGround             bool
}

// OnGround returns whether the entity is on the ground.
func (m *Movement) OnGround() bool {
	return m.onGround
}

// Position returns the position as a result of the Movement as an mgl64.Vec3.
func (m *Movement) Position() mgl64.Vec3 {
	return m.pos
}

// Velocity returns the velocity after the Movement as an mgl64.Vec3.
func (m *Movement) Velocity() mgl64.Vec3 {
	return m.vel
}

type Computer struct {
	Gravity, Drag     float64
	DragBeforeGravity bool

	onGround bool
}

func (c *Computer) TickMovement(box cube.BBox, pos, vel mgl64.Vec3, rot cube.Rotation, source world.BlockSource) *Movement {
	if !finiteVec(pos) {
		// A poisoned position makes every collision bound garbage; freeze
		// rather than sweep the world (run 35: a NaN reached the mover and
		// the tick loop spun in Block() at y=-152M until SIGKILL).
		return &Movement{pos: pos, onGround: c.onGround}
	}
	velBefore := vel
	vel = clampVel(c.applyHorizontalForces(source, pos, c.applyVerticalForces(vel)))
	dPos, vel, onGround := CheckCollision(source, box, pos, vel)
	c.onGround = onGround
	return &Movement{
		pos: pos.Add(dPos), vel: vel, dpos: dPos, dvel: vel.Sub(velBefore),
		onGround: c.onGround,
	}
}

func (c *Computer) applyHorizontalForces(source world.BlockSource, pos, vel mgl64.Vec3) mgl64.Vec3 {
	friction := 1 - c.Drag
	if c.onGround {
		if f, ok := source.Block(cube.PosFromVec3(pos).Side(cube.FaceDown)).(interface {
			Friction() float64
		}); ok {
			friction *= f.Friction()
		} else {
			friction *= 0.6
		}
	}
	vel[0] *= friction
	vel[2] *= friction
	return vel
}

func (c *Computer) applyVerticalForces(vel mgl64.Vec3) mgl64.Vec3 {
	if c.DragBeforeGravity {
		vel[1] *= 1 - c.Drag
	}
	vel[1] -= c.Gravity
	if !c.DragBeforeGravity {
		vel[1] *= 1 - c.Drag
	}
	return vel
}

// CheckCollision limits collision.
func CheckCollision(source world.BlockSource, box cube.BBox, pos, vel mgl64.Vec3) (mgl64.Vec3, mgl64.Vec3, bool) {
	// TODO: Implement collision with other entities.
	vel = clampVel(vel)
	deltaX, deltaY, deltaZ := vel[0], vel[1], vel[2]
	var onGround bool

	// Entities only ever have a single bounding box.
	entityBBox := box.Translate(pos)
	blocks := blockBBoxsAround(source, entityBBox.Extend(vel))

	if !mgl64.FloatEqualThreshold(deltaY, 0, epsilon) {
		// First we move the entity BBox on the Y axis.
		for _, blockBBox := range blocks {
			deltaY = entityBBox.YOffset(blockBBox, deltaY)
		}
		entityBBox = entityBBox.Translate(mgl64.Vec3{0, deltaY})
	}
	if !mgl64.FloatEqualThreshold(deltaX, 0, epsilon) {
		// Then on the X axis.
		for _, blockBBox := range blocks {
			deltaX = entityBBox.XOffset(blockBBox, deltaX)
		}
		entityBBox = entityBBox.Translate(mgl64.Vec3{deltaX})
	}
	if !mgl64.FloatEqualThreshold(deltaZ, 0, epsilon) {
		// And finally on the Z axis.
		for _, blockBBox := range blocks {
			deltaZ = entityBBox.ZOffset(blockBBox, deltaZ)
		}
	}
	if !mgl64.FloatEqual(vel[1], 0) {
		// The Y velocity of the entity is currently not 0, meaning it is moving either up or down. We can
		// then assume the entity is not currently on the ground.
		onGround = false
	}
	if !mgl64.FloatEqual(deltaX, vel[0]) {
		vel[0] = 0
	}
	if !mgl64.FloatEqual(deltaY, vel[1]) {
		// The entity either hit the ground or hit the ceiling.
		if vel[1] < 0 {
			// The entity was going down, so we can assume it is now on the ground.
			onGround = true
		}
		vel[1] = 0
	}
	if !mgl64.FloatEqual(deltaZ, vel[2]) {
		vel[2] = 0
	}
	return mgl64.Vec3{deltaX, deltaY, deltaZ}, vel, onGround
}

// maxVelocity is a hard per-axis cap on the velocity the mover will simulate,
// in blocks per tick. Vanilla terminal falling speed is ~3.92; anything past
// this is a poisoned value (NaN arithmetic, a bogus SetActorMotion) whose
// collision sweep would visit an unbounded block volume.
const maxVelocity = 10.0

// finiteVec reports whether every component of v is a finite number.
//
// @param v The vector to check.
// @returns false when any component is NaN or infinite.
func finiteVec(v mgl64.Vec3) bool {
	for _, c := range v {
		if math.IsNaN(c) || math.IsInf(c, 0) {
			return false
		}
	}
	return true
}

// clampVel sanitises a velocity: non-finite components collapse to zero and
// finite ones are clamped to ±maxVelocity, so the collision sweep in
// blockBBoxsAround always covers a bounded volume.
//
// @param vel The velocity to sanitise.
// @returns the sanitised velocity.
func clampVel(vel mgl64.Vec3) mgl64.Vec3 {
	for i, c := range vel {
		switch {
		case math.IsNaN(c) || math.IsInf(c, 0):
			vel[i] = 0
		case c > maxVelocity:
			vel[i] = maxVelocity
		case c < -maxVelocity:
			vel[i] = -maxVelocity
		}
	}
	return vel
}

// maxSweepVolume bounds the block volume one collision sweep may visit.
// A legitimate sweep (player box grown 0.25, extended by a clamped velocity)
// stays under ~200 blocks; anything bigger is poisoned input.
const maxSweepVolume = 4096

// blockBBoxsAround ...
func blockBBoxsAround(source world.BlockSource, box cube.BBox) []cube.BBox {
	grown := box.Grow(0.25)
	min, max := grown.Min(), grown.Max()
	if !finiteVec(min) || !finiteVec(max) {
		return nil
	}
	minX, minY, minZ := int(math.Floor(min[0])), int(math.Floor(min[1])), int(math.Floor(min[2]))
	maxX, maxY, maxZ := int(math.Ceil(max[0])), int(math.Ceil(max[1])), int(math.Ceil(max[2]))
	if vol := (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1); vol < 0 || vol > maxSweepVolume {
		return nil
	}

	// A prediction of one BBox per block, plus an additional 2, in case
	blockBBoxs := make([]cube.BBox, 0, (maxX-minX)*(maxY-minY)*(maxZ-minZ)+2)
	for y := minY; y <= maxY; y++ {
		for x := minX; x <= maxX; x++ {
			for z := minZ; z <= maxZ; z++ {
				pos := cube.Pos{x, y, z}
				// Network-decoded blocks (e.g. ShulkerBox with nil progress) can
				// panic in Model(); treat them as a full solid cube instead of
				// killing the tick loop mid-walk.
				boxes := safeBBoxs(source.Block(pos), pos, source)
				for _, box := range boxes {
					blockBBoxs = append(blockBBoxs, box.Translate(mgl64.Vec3{float64(x), float64(y), float64(z)}))
				}
			}
		}
	}
	return blockBBoxs
}

const epsilon = 0.001

// safeBBoxs returns Model().BBox for bl, or a full cube when Model panics.
//
// @param bl Block at pos.
// @param pos Block coordinates.
// @param source Block source passed to Model.
// @returns collision boxes in block-local space.
func safeBBoxs(bl world.Block, pos cube.Pos, source world.BlockSource) (boxes []cube.BBox) {
	defer func() {
		if recover() != nil {
			boxes = []cube.BBox{cube.Box(0, 0, 0, 1, 1, 1)}
		}
	}()
	return bl.Model().BBox(pos, source)
}
