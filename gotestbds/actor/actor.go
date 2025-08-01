package actor

import (
	"fmt"
	"iter"
	"math"
	"time"
	_ "unsafe"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/block/cube/trace"
	"github.com/df-mc/dragonfly/server/block/model"
	"github.com/df-mc/dragonfly/server/entity/effect"
	"github.com/df-mc/dragonfly/server/item"
	"github.com/df-mc/dragonfly/server/item/enchantment"
	"github.com/df-mc/dragonfly/server/player/skin"
	w "github.com/df-mc/dragonfly/server/world"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// Actor simulates client actions.
type Actor struct {
	*entity.Player

	world *world.World

	actorData

	conn Conn
}

// NewActor ...
func NewActor(conn *minecraft.Conn) *Actor {
	identity := conn.IdentityData()
	gameData := conn.GameData()
	pl := entity.CreateFromPacket(&packet.AddPlayer{
		UUID:            uuid.MustParse(identity.Identity),
		Username:        identity.DisplayName,
		EntityRuntimeID: gameData.EntityRuntimeID,
		Position:        gameData.PlayerPosition,
		GameType:        gameData.PlayerGameMode,
	})

	w := world.NewWorld()
	w.AddEntity(pl)

	actor := &Actor{
		conn:   conn,
		world:  w,
		Player: pl.(*entity.Player),
	}
	return actor
}

// World ...
func (a *Actor) World() *world.World {
	return a.world
}

// Close ...
func (a *Actor) Close() error {
	// TODO...
	return nil
}

// Attack attacks passed entity.
func (a *Actor) Attack(e world.Entity) bool {
	_, ok := a.world.Entity(e.RuntimeID())
	if !ok {
		return false
	}

	heldItem, _ := a.Inventory().ItemInstance(a.heldSlot)
	action := &protocol.UseItemOnEntityTransactionData{
		TargetEntityRuntimeID: e.RuntimeID(),
		ActionType:            protocol.UseItemOnEntityActionAttack,
		HotBarSlot:            int32(a.heldSlot),
		HeldItem:              heldItem,
		Position:              mcmath.Vec64To32(a.Position()),
		ClickedPosition:       mcmath.Vec64To32(e.Position()),
	}
	a.useItem(action)

	return true
}

// Effects ...
func (a *Actor) Effects() iter.Seq[effect.Effect] {
	return a.effectManager.Effects()
}

// Effect ...
func (a *Actor) Effect(e effect.Type) (effect.Effect, bool) {
	return a.effectManager.Effect(e)
}

// AddEffect ...
func (a *Actor) AddEffect(eff effect.Effect) {
	a.effectManager.Add(eff)
}

// RemoveEffect ...
func (a *Actor) RemoveEffect(eff effect.Type) {
	a.effectManager.Remove(eff)
}

// SetHeldSlot sets held slot.
func (a *Actor) SetHeldSlot(slot int) error {
	if slot < 0 || slot > 8 {
		return fmt.Errorf("slot exceeds hotbar range 0-8: slot is %v", slot)
	}

	heldItem, _ := a.Inventory().ItemInstance(slot)
	a.heldSlot = slot

	return a.conn.WritePacket(&packet.MobEquipment{
		EntityRuntimeID: a.RuntimeID(),
		NewItem:         heldItem,
		InventorySlot:   byte(slot),
		HotBarSlot:      byte(slot),
		WindowID:        protocol.WindowIDInventory,
	})
}

// HeldItem returns item in the held slot.
func (a *Actor) HeldItem() item.Stack {
	it, _ := a.Inventory().Item(a.heldSlot)
	return it
}

// StartBreakingBlock starts breaking block at position passed and returns estimated break time.
func (a *Actor) StartBreakingBlock(pos cube.Pos) (time.Duration, bool) {
	bl := a.World().Block(pos)
	_, ok := bl.(block.Breakable)
	if !ok {
		return math.MaxInt64, false
	}

	a.abortBreaking = false
	a.breakingBlock = true
	a.breakingPos = pos
	return a.breakTime(pos), true
}

// breakTime ...
func (a *Actor) breakTime(pos cube.Pos) time.Duration {
	held := a.HeldItem()
	breakTime := block.BreakDuration(a.world.Block(pos), held)
	if !a.OnGround() {
		breakTime *= 5
	}

	if _, ok := a.Armour().Helmet().Enchantment(enchantment.AquaAffinity); a.insideOfWater() && !ok {
		breakTime *= 5
	}
	for e := range a.Effects() {
		lvl := e.Level()
		switch e.Type() {
		case effect.Haste:
			breakTime = time.Duration(float64(breakTime) * effect.Haste.Multiplier(lvl))
		case effect.MiningFatigue:
			breakTime = time.Duration(float64(breakTime) * effect.MiningFatigue.Multiplier(lvl))
		case effect.ConduitPower:
			breakTime = time.Duration(float64(breakTime) * effect.ConduitPower.Multiplier(lvl))
		}
	}
	return breakTime
}

// insideOfWater ...
func (a *Actor) insideOfWater() bool {
	pos := cube.PosFromVec3(a.EyePos())
	if l, ok := a.world.Liquid(pos); ok {
		if _, ok := l.(block.Water); ok {
			d := float64(l.SpreadDecay()) + 1
			if l.LiquidFalling() {
				d = 1
			}
			return a.Position().Y() < (pos.Side(cube.FaceUp).Vec3().Y())-(d/9-breathingDistanceBelowEyes)
		}
	}
	return false
}

const breathingDistanceBelowEyes = 0.11111111

// EyeHeight ...
func (a *Actor) EyeHeight() float64 {
	switch {
	case a.swimming || a.crawling || a.gliding:
		return 0.52
	case a.sneaking:
		return 1.26
	default:
		return 1.62
	}
}

// EyePos returns eye position.
func (a *Actor) EyePos() mgl64.Vec3 {
	return a.Position().Add(mgl64.Vec3{0, a.EyeHeight()})
}

// Inventory ...
func (a *Actor) Inventory() *inventory.Handle {
	return a.inv
}

// Offhand ...
func (a *Actor) Offhand() *inventory.Handle {
	return a.offhand
}

// Armour ...
func (a *Actor) Armour() *inventory.Armour {
	return a.armor
}

// Tick - simulates client tick.
func (a *Actor) Tick() {
	a.tickMovement()

}

// LookAt makes Actor look at the point.
func (a *Actor) LookAt(point mgl64.Vec3) {
	pos := a.EyePos()
	horizontal := math.Sqrt(math.Pow(point.X()-pos.X(), 2) + math.Pow(point.Z()-pos.Z(), 2))
	vertical := point.Y() - (pos.Y())
	pitch := -math.Atan2(vertical, horizontal) * 180 / math.Pi

	xDist := point.X() - pos.X()
	zDist := point.Z() - pos.Z()

	yaw := math.Atan2(zDist, xDist)*180/math.Pi - 90
	if yaw < 0 {
		yaw += 360.0
	}

	a.Move(a.Position(), cube.Rotation{yaw, pitch})
}

// LookAtBlock makes Actor look at the block position passed.
func (a *Actor) LookAtBlock(pos cube.Pos) {
	a.LookAt(pos.Vec3Centre())
}

// LookAtEntity makes Actor look at the entity passed.
func (a *Actor) LookAtEntity(e world.Entity) {
	a.LookAt(e.Position().Add(mgl64.Vec3{0, e.State().Box().Height()}))
}

// BlockFromViewDirection returns block, position & face of the block actor is looking at,
// if within 100 blocks there are no blocks, it will return the air.
func (a *Actor) BlockFromViewDirection() (block w.Block, pos cube.Pos, face cube.Face) {
	block, pos, face, _ = a.posFromView(100)
	return block, pos, face
}

// PosFromViewDirection returns position actor is looking at
func (a *Actor) PosFromViewDirection() (onBlock mgl64.Vec3, blockPos cube.Pos, succeed bool) {
	bl, pos, _, vec := a.posFromView(100)
	_, succeed = bl.(block.Air)
	return vec.Sub(pos.Vec3()), pos, succeed
}

// posFromView returns block, position, face, position on the block actor is looking at.
// it will return air in case it missed.
func (a *Actor) posFromView(r int) (w.Block, cube.Pos, cube.Face, mgl64.Vec3) {
	start := a.EyePos()
	end := a.Rotation().Vec3().Mul(float64(r)).Add(start)
	var (
		face                    cube.Face
		bl                      w.Block
		currentPos, previousPos cube.Pos
		posOnBlock              mgl64.Vec3
	)
	trace.TraverseBlocks(start, end, func(pos cube.Pos) (con bool) {
		previousPos = currentPos
		currentPos = pos
		bl = a.world.Block(pos)
		_, pass := bl.Model().(model.Empty)
		if !pass {
			// ensuring we hit the block.
			result, ok := trace.BlockIntercept(pos, a.world, bl, start, end)
			if ok {
				face = result.Face()
				posOnBlock = result.Position()
			}
			pass = !ok
		}
		return pass
	})

	if _, miss := bl.(block.Air); miss {
		face = currentPos.Face(previousPos)
	}
	return bl, currentPos, face, posOnBlock
}

// Chat writes message to chat.
func (a *Actor) Chat(message string) {
	identity := a.conn.IdentityData()
	_ = a.conn.WritePacket(&packet.Text{
		TextType:   packet.TextTypeChat,
		SourceName: identity.DisplayName,
		Message:    message,
		XUID:       identity.XUID,
	})
}

// UseItem uses item in heldSlot.
func (a *Actor) UseItem() {
	heldItem, _ := a.Inventory().ItemInstance(a.heldSlot)
	action := &protocol.UseItemTransactionData{
		ActionType: protocol.UseItemActionClickAir,
		HotBarSlot: int32(a.heldSlot),
		HeldItem:   heldItem,
	}

	a.useItem(action)
}

// UseItemOnBlock uses item in heldSlot on the block.
func (a *Actor) UseItemOnBlock(pos cube.Pos, face cube.Face, clickPos mgl64.Vec3) {
	heldItem, _ := a.Inventory().ItemInstance(a.heldSlot)
	action := &protocol.UseItemTransactionData{
		HotBarSlot:      int32(a.heldSlot),
		HeldItem:        heldItem,
		ActionType:      protocol.UseItemActionClickBlock,
		BlockPosition:   protocol.BlockPos{int32(pos[0]), int32(pos[1]), int32(pos[2])},
		BlockFace:       int32(face),
		ClickedPosition: mcmath.Vec64To32(clickPos),
	}

	a.useItem(action)
}

// ReleaseItem stops using held item.
func (a *Actor) ReleaseItem() {
	actionType := protocol.ReleaseItemActionRelease
	it, _ := a.Inventory().Item(a.heldSlot)
	if _, consumable := it.Item().(item.Consumable); consumable {
		actionType = protocol.ReleaseItemActionConsume
	}
	heldItem, _ := a.Inventory().ItemInstance(a.heldSlot)
	action := &protocol.ReleaseItemTransactionData{
		ActionType:   uint32(actionType),
		HotBarSlot:   int32(a.heldSlot),
		HeldItem:     heldItem,
		HeadPosition: mcmath.Vec64To32(a.EyePos()),
	}

	a.useItem(action)
}

// UseItemOnEntity uses held item on entity.
func (a *Actor) UseItemOnEntity(e world.Entity) {
	heldItem, _ := a.Inventory().ItemInstance(a.heldSlot)
	action := &protocol.UseItemOnEntityTransactionData{
		TargetEntityRuntimeID: e.RuntimeID(),
		ActionType:            protocol.UseItemOnEntityActionAttack,
		HotBarSlot:            int32(a.heldSlot),
		HeldItem:              heldItem,
		Position:              mcmath.Vec64To32(a.Position()),
		ClickedPosition:       mcmath.Vec64To32(e.Position()),
	}

	a.useItem(action)
}

// useItem sends InventoryTransaction packet.
func (a *Actor) useItem(data protocol.InventoryTransactionData) {
	_ = a.conn.WritePacket(&packet.InventoryTransaction{
		TransactionData: data,
	})
}

// Respawn respawn's the Actor.
func (a *Actor) Respawn() {
	_ = a.conn.WritePacket(&packet.Respawn{
		State:           packet.RespawnStateClientReadyToSpawn,
		EntityRuntimeID: a.conn.GameData().EntityRuntimeID,
	})
}

// SetSkin sets Actor's skin.
func (a *Actor) SetSkin(skin skin.Skin) {
	_ = a.conn.WritePacket(&packet.PlayerSkin{
		UUID: a.UUID(),
		Skin: skinToProtocol(skin),
	})
}

// Health ...
func (a *Actor) Health() float64 {
	return a.Attributes().Health()
}

// CanSprint ...
func (a *Actor) CanSprint() bool {
	return a.Attributes().Food() > 6
}

// RunCommand runs the command on the server side.
func (a *Actor) RunCommand(cmd string) {
	_ = a.conn.WritePacket(&packet.CommandRequest{
		CommandLine: cmd,
		CommandOrigin: protocol.CommandOrigin{
			Origin:         protocol.CommandOriginPlayer,
			UUID:           uuid.New(),
			PlayerUniqueID: a.conn.GameData().EntityUniqueID,
		},
	})
}

//go:linkname skinToProtocol github.com/df-mc/dragonfly/server/player/skin.skinToProtocol
func skinToProtocol(s skin.Skin) protocol.Skin
