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
	"github.com/df-mc/dragonfly/server/event"
	"github.com/df-mc/dragonfly/server/item"
	"github.com/df-mc/dragonfly/server/item/enchantment"
	"github.com/df-mc/dragonfly/server/player/skin"
	w "github.com/df-mc/dragonfly/server/world"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/google/uuid"
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
	h Handler

	world *world.World

	actorData

	conn Conn
}

// Handler returns Actor's handler.
func (a *Actor) Handler() Handler {
	return a.h
}

// Handle sets Actor's handler.
func (a *Actor) Handle(h Handler) {
	if h == nil {
		h = NopHandler{}
	}
	a.h = h
}

// World returns Actor's world.
func (a *Actor) World() *world.World {
	return a.world
}

// Close ...
func (a *Actor) Close() error {
	// TODO...
	return nil
}

// AttackEntity attacks passed entity.
func (a *Actor) AttackEntity(e world.Entity) error {
	_, ok := a.world.Entity(e.RuntimeID())
	if !ok {
		return fmt.Errorf("entity with %d runtimeID not found", e.RuntimeID())
	}

	clickPos, err := a.AbleToInteractWithEntity(e)
	if err != nil {
		return err
	}

	ctx := event.C(a)
	if a.Handler().HandleAttack(ctx, e); ctx.Cancelled() {
		return ErrActionCanceled{"AttackEntity"}
	}

	heldItem, _ := a.Inventory().ItemInstance(a.heldSlot)
	action := &protocol.UseItemOnEntityTransactionData{
		TargetEntityRuntimeID: e.RuntimeID(),
		ActionType:            protocol.UseItemOnEntityActionAttack,
		HotBarSlot:            int32(a.heldSlot),
		HeldItem:              heldItem,
		Position:              mcmath.Vec64To32(a.Position()),
		ClickedPosition:       mcmath.Vec64To32(clickPos),
	}

	return a.useItem(action)
}

// Attack attacks entity that Actor is looking at.
func (a *Actor) Attack() error {
	ent, ok := a.EntityFromViewDirection(func(e world.Entity) bool {
		_, isItem := e.(*entity.Item)
		return !isItem
	}, false)
	if !ok {
		return fmt.Errorf("unable to find entity within Actor's range")
	}
	return a.AttackEntity(ent)
}

// Effects returns Actor's effects.
func (a *Actor) Effects() iter.Seq[effect.Effect] {
	return a.effectManager.Effects()
}

// Effect returns Effect of type passed.
func (a *Actor) Effect(e effect.Type) (effect.Effect, bool) {
	return a.effectManager.Effect(e)
}

// AddEffect adds effect on Actor.
func (a *Actor) AddEffect(eff effect.Effect) {
	ctx := event.C(a)
	if a.Handler().HandleAddEffect(ctx, eff); ctx.Cancelled() {
		return
	}
	a.effectManager.Add(eff)
}

// RemoveEffect removes effect from Actor.
func (a *Actor) RemoveEffect(eff effect.Type) {
	ctx := event.C(a)
	if a.Handler().HandleRemoveEffect(ctx, eff); ctx.Cancelled() {
		return
	}
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

// HeldSlot returns held slot number.
func (a *Actor) HeldSlot() int {
	return a.heldSlot
}

// StartBreakingBlock starts breaking block at position passed and returns estimated break time.
func (a *Actor) StartBreakingBlock(pos cube.Pos) (time.Duration, error) {
	bl := a.World().Block(pos)
	_, err := a.AbleToInteractWithBlock(bl, pos)
	if err != nil {
		return math.MaxInt64, err
	}

	a.BlockFromViewDirection()

	if a.Gamemode() == 1 {
		ctx := event.C(a)
		if a.Handler().HandleBlockBreak(ctx, pos, bl); ctx.Cancelled() {
			return math.MaxInt64, ErrActionCanceled{"StartBreakingBlock"}
		}

		a.world.SetBlock(pos, block.Air{})

		supporter, _ := a.resolveBlockSupporter(pos)

		a.world.SetBlock(pos, block.Air{})
		return 0, a.conn.WritePacket(&packet.PlayerAction{
			EntityRuntimeID: a.RuntimeID(),
			ActionType:      protocol.PlayerActionCreativePlayerDestroyBlock,
			BlockPosition:   posToProtocol(pos),
			BlockFace:       int32(pos.Face(supporter)),
		})
	}

	_, ok := bl.(block.Breakable)
	if !ok {
		name, _ := bl.EncodeBlock()
		return math.MaxInt64, fmt.Errorf("block %v is unbreakable", name)
	}

	ctx := event.C(a)
	if a.Handler().HandleStartBreak(ctx, pos); ctx.Cancelled() {
		return math.MaxInt64, ErrActionCanceled{"StartBreakingBlock"}
	}

	a.abortBreaking = false
	a.breakingBlock = true
	a.breakingPos = pos
	return a.BreakTime(pos), nil
}

// BreakTime returns break time of the block at position passed.
func (a *Actor) BreakTime(pos cube.Pos) time.Duration {
	held := a.HeldItem()
	breakTime := block.BreakDuration(a.world.Block(pos), held)
	if !a.OnGround() {
		breakTime *= 5
	}

	if _, ok := a.Armour().Helmet().Enchantment(enchantment.AquaAffinity); a.InsideOfWater() && !ok {
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

// InsideOfWater returns whether the Actor is inside the water.
func (a *Actor) InsideOfWater() bool {
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

// EyeHeight returns current Actor's eye height.
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

// Inventory returns Actor's main inventory.
func (a *Actor) Inventory() *inventory.Handle {
	return a.inv
}

// Offhand returns Actor's offhand inventory.
func (a *Actor) Offhand() *inventory.Handle {
	return a.offhand
}

// UiInv returns Actor's ui inventory.
func (a *Actor) UiInv() *inventory.Handle {
	return a.ui
}

// Armour returns Actor's Armour.
func (a *Actor) Armour() *inventory.Armour {
	return a.armor
}

// HeldItems ...
func (a *Actor) HeldItems() (item.Stack, item.Stack) {
	main := a.HeldItem()
	off, _ := a.Offhand().Item(0)
	return main, off
}

// SetHeldItems calling this function won't affect Actor's inventory.
func (a *Actor) SetHeldItems(main, off item.Stack) error {
	return fmt.Errorf("you can not set Actor's inventory directly")
}

// Tick - simulates client tick.
func (a *Actor) Tick() {
	a.Handler().HandleTick(a, a.CurrentTick())
	a.tickMovement()
	a.tickNavigating()
	a.unloadChunks()
}

// NearestEntity returns nearest to Actor entity and distance to it.
func (a *Actor) NearestEntity(filter func(e world.Entity) bool) (world.Entity, float64, bool) {
	var nearest world.Entity
	var distanceToNearest = math.MaxFloat64
	for ent := range a.world.Entities() {
		if filter != nil && !filter(ent) || ent.RuntimeID() == a.RuntimeID() {
			continue
		}
		// using squared distance for performance.
		distance := ent.Position().Sub(a.Position()).LenSqr()
		if distance < distanceToNearest {
			nearest = ent
			distanceToNearest = distance
		}
	}
	return nearest, math.Sqrt(distanceToNearest), nearest != nil
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
	a.LookAt(e.Position().Add(mgl64.Vec3{0, e.State().Box().Height() * (3 / 4)}))
}

// BlockFromViewDirection returns block, position & face of the block actor is looking at,
// if within 100 blocks there are no blocks, it will return the air.
func (a *Actor) BlockFromViewDirection() (block w.Block, pos cube.Pos, face cube.Face) {
	block, pos, face, _ = posFromRotation(12, a.Rotation(), a.EyePos(), a.world)
	return block, pos, face
}

// PosFromViewDirection returns position actor is looking at.
func (a *Actor) PosFromViewDirection(r int) (onBlock mgl64.Vec3, blockPos cube.Pos, succeed bool) {
	bl, pos, _, vec := posFromRotation(r, a.Rotation(), a.EyePos(), a.world)
	_, succeed = bl.(block.Air)
	return vec.Sub(pos.Vec3()), pos, succeed
}

// posFromRotation returns block, position, face, position on the block actor is looking at.
// it will return air in case it missed.
func posFromRotation(r int, rotation cube.Rotation, start mgl64.Vec3, world *world.World) (w.Block, cube.Pos, cube.Face, mgl64.Vec3) {
	end := rotation.Vec3().Mul(float64(r)).Add(start)
	var (
		face                    cube.Face
		bl                      w.Block
		currentPos, previousPos cube.Pos
		posOnBlock              mgl64.Vec3
	)
	trace.TraverseBlocks(start, end, func(pos cube.Pos) (con bool) {
		previousPos = currentPos
		currentPos = pos
		bl = world.Block(pos)
		_, pass := bl.Model().(model.Empty)
		if !pass {
			// ensuring we hit the block.
			result, ok := trace.BlockIntercept(pos, world, bl, start, end)
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

// EntityFromViewDirection returns entity that player is looking at.
func (a *Actor) EntityFromViewDirection(filter func(e world.Entity) bool, behindWall bool) (world.Entity, bool) {
	start := a.EyePos()
	end := a.Rotation().Vec3().Mul(5).Add(start)

	var nearest world.Entity
	var distanceToNearest = math.MaxFloat64
	var entityResult trace.BBoxResult

	trace.TraverseBlocks(start, end, func(pos cube.Pos) (con bool) {
		for ent := range a.world.Entities() {
			if filter != nil && !filter(ent) || ent.RuntimeID() == a.RuntimeID() {
				continue
			}
			var ok bool

			entityResult, ok = trace.BBoxIntercept(ent.State().Box().Translate(ent.Position()), start, end)
			if !ok {
				continue
			}

			distance := entityResult.Position().Sub(start).LenSqr()
			if distance < distanceToNearest {
				if !behindWall && a.CanInteractWithEntity(pos, start, end, ent) {
					continue
				}

				distanceToNearest = distance
				nearest = ent
			}
		}

		found := nearest != nil

		return !found
	})
	return nearest, nearest != nil
}

// CanInteractWithEntity returns whether there is any obstacle between Actor & Entity.
func (a *Actor) CanInteractWithEntity(pos cube.Pos, start, end mgl64.Vec3, ent world.Entity) bool {
	blockResult, blockOk := trace.BlockIntercept(pos, a.world, a.world.Block(pos), start, end)
	if !blockOk {
		return true
	}
	box := ent.State().Box().Translate(ent.Position())
	boxResult, boxOk := trace.BBoxIntercept(box, start, end)
	if !boxOk {
		return false
	}
	return start.Sub(blockResult.Position()).LenSqr() > start.Sub(boxResult.Position()).LenSqr()
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

// ReceiveMessage ...
func (a *Actor) ReceiveMessage(message string) {
	a.Handler().HandleReceiveMessage(a, message)
}

// ReceiveForm ...
func (a *Actor) ReceiveForm(form *Form) {
	ctx := event.C(a)
	a.Handler().HandleReceiveForm(ctx, form)
	if !form.used && !ctx.Cancelled() {
		_ = form.Ignore()
	} else {
		a.lastForm = form
	}
}

// LastForm returns last Form received.
func (a *Actor) LastForm() (*Form, bool) {
	if a.lastForm == nil || a.lastForm.used {
		return nil, false
	}
	return a.lastForm, true
}

// ReceiveSign ...
func (a *Actor) ReceiveSign(s *Sign) {
	a.Handler().HandleReceiveSign(a, s)
	if !s.edited {
		a.lastSign = s
	}
}

// LastSign returns last Sign received.
func (a *Actor) LastSign() (*Sign, bool) {
	if a.lastSign == nil || a.lastSign.edited {
		return nil, false
	}
	return a.lastSign, true
}

// ReceiveDialogue ...
func (a *Actor) ReceiveDialogue(d *Dialogue) {
	ctx := event.C(a)
	a.Handler().HandleReceiveDialogue(ctx, d)
	if !d.used && !ctx.Cancelled() {
		_ = d.Ignore()
	} else {
		a.lastDialogue = d
	}
}

// LastDialogue returns last Dialogue received.
func (a *Actor) LastDialogue() (*Dialogue, bool) {
	if a.lastDialogue == nil || a.lastDialogue.used {
		return nil, false
	}
	return a.lastDialogue, true
}

// UseItem uses item in heldSlot.
func (a *Actor) UseItem() error {
	ctx := event.C(a)
	if a.Handler().HandleUseItem(ctx, a.HeldItem()); ctx.Cancelled() {
		return ErrActionCanceled{"UseItem"}
	}

	heldItem, _ := a.Inventory().ItemInstance(a.heldSlot)
	action := &protocol.UseItemTransactionData{
		ActionType: protocol.UseItemActionClickAir,
		HotBarSlot: int32(a.heldSlot),
		HeldItem:   heldItem,
		BlockFace:  -1,
	}

	return a.useItem(action)
}

// UseItemOnBlock uses item in heldSlot on the block.
func (a *Actor) UseItemOnBlock(pos cube.Pos, face cube.Face, clickPos mgl64.Vec3) error {
	_, err := a.AbleToInteractWithBlock(a.world.Block(pos), pos)
	if err != nil {
		return err
	}

	ctx := event.C(a)
	if a.Handler().HandleUseItemOnBlock(ctx, a.HeldItem(), pos); ctx.Cancelled() {
		return ErrActionCanceled{"UseItemOnBlock"}
	}

	heldItem, _ := a.Inventory().ItemInstance(a.heldSlot)
	action := &protocol.UseItemTransactionData{
		HotBarSlot:      int32(a.heldSlot),
		HeldItem:        heldItem,
		ActionType:      protocol.UseItemActionClickBlock,
		BlockPosition:   posToProtocol(pos),
		BlockFace:       int32(face),
		ClickedPosition: mcmath.Vec64To32(clickPos),
	}
	_ = a.useItem(action)

	return a.conn.WritePacket(&packet.PlayerAction{
		EntityRuntimeID: a.RuntimeID(),
		ActionType:      protocol.PlayerActionStartItemUseOn,
		BlockPosition:   posToProtocol(pos),
		ResultPosition:  posToProtocol(pos.Side(face)),
		BlockFace:       int32(face),
	})
}

// ReleaseItem stops using held item.
func (a *Actor) ReleaseItem() error {
	ctx := event.C(a)
	if a.Handler().HandleReleaseItem(ctx, a.HeldItem()); ctx.Cancelled() {
		return ErrActionCanceled{"ReleaseItem"}
	}

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

	return a.useItem(action)
}

// UseItemOnEntity uses held item on entity.
func (a *Actor) UseItemOnEntity(e world.Entity) error {
	clickPos, err := a.AbleToInteractWithEntity(e)
	if err != nil {
		return err
	}

	ctx := event.C(a)
	if a.Handler().HandleUseItemOnEntity(ctx, a.HeldItem(), e); ctx.Cancelled() {
		return ErrActionCanceled{"UseItemOnEntity"}
	}

	heldItem, _ := a.Inventory().ItemInstance(a.heldSlot)
	action := &protocol.UseItemOnEntityTransactionData{
		TargetEntityRuntimeID: e.RuntimeID(),
		ActionType:            protocol.UseItemOnEntityActionAttack,
		HotBarSlot:            int32(a.heldSlot),
		HeldItem:              heldItem,
		Position:              mcmath.Vec64To32(a.Position()),
		ClickedPosition:       mcmath.Vec64To32(clickPos),
	}

	return a.useItem(action)
}

// useItem sends InventoryTransaction packet.
func (a *Actor) useItem(data protocol.InventoryTransactionData) error {
	return a.conn.WritePacket(&packet.InventoryTransaction{
		TransactionData: data,
	})
}

// Respawn respawns the Actor.
func (a *Actor) Respawn() {
	_ = a.conn.WritePacket(&packet.Respawn{
		State:           packet.RespawnStateClientReadyToSpawn,
		EntityRuntimeID: a.conn.GameData().EntityRuntimeID,
	})

	_ = a.conn.WritePacket(&packet.PlayerAction{
		EntityRuntimeID: a.RuntimeID(),
		ActionType:      protocol.PlayerActionRespawn,
	})
}

// SetSkin sets Actor's skin.
func (a *Actor) SetSkin(skin skin.Skin) {
	_ = a.conn.WritePacket(&packet.PlayerSkin{
		UUID: a.UUID(),
		Skin: skinToProtocol(skin),
	})
}

// Health returns Actor's health.
func (a *Actor) Health() float64 {
	return a.Attributes().Health()
}

// CanSprint returns whether the Actor is able to sprint.
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

// SetChunkLoadCenter sets chunk loading center.
func (a *Actor) SetChunkLoadCenter(pos cube.Pos) {
	a.loadingCenter = pos
}

// RequestRenderDistance requests new chunk radius.
func (a *Actor) RequestRenderDistance(chunkRadius int) {
	_ = a.conn.WritePacket(&packet.RequestChunkRadius{ChunkRadius: int32(chunkRadius)})
}

// SetChunkRadius sets chunk radius.
func (a *Actor) SetChunkRadius(chunkRadius int) {
	a.chunkRadius = chunkRadius
}

// ChunkRadius ...
func (a *Actor) ChunkRadius() int {
	return a.chunkRadius
}

// unloadChunks unloads chunks.
func (a *Actor) unloadChunks() {
	current := w.ChunkPos{int32(a.loadingCenter.X() >> 4), int32(a.loadingCenter.Z() >> 4)}
	for pos := range a.world.Chunks() {
		diffX, diffZ := pos[0]-current[0], pos[1]-current[1]
		dist := math.Sqrt(float64(diffX*diffX) + float64(diffZ*diffZ))
		if int(dist) > a.chunkRadius {
			a.world.RemoveChunk(pos)
		}
	}
}

// PlaceBlock makes Actor to place a block.
func (a *Actor) PlaceBlock(pos cube.Pos) error {
	held := a.HeldItem()
	if held.Empty() {
		return fmt.Errorf("main hand is empty")
	}

	bl, ok := held.Item().(w.Block)
	if !ok {
		return fmt.Errorf("held item is not a block")
	}

	supporter, ok := a.resolveBlockSupporter(pos)
	if !ok {
		return fmt.Errorf("failed resolving support block")
	}

	if !a.inv.Spend(a.heldSlot) {
		return fmt.Errorf("unable to spend item in the main hand")
	}

	a.world.SetBlock(pos, bl)
	return a.UseItemOnBlock(supporter, supporter.Face(pos), mgl64.Vec3{})
}

// resolveBlockSupporter tries to find block position on which Actor can place block.
func (a *Actor) resolveBlockSupporter(pos cube.Pos) (cube.Pos, bool) {
	// trying to resolve block from Actor's position.
	start := a.EyePos()
	destination := pos.Vec3Centre()
	direction := destination.Sub(start)

	var blockBehind cube.Pos
	trace.TraverseBlocks(destination, destination.Add(direction), func(blockPos cube.Pos) (con bool) {
		blockBehind = blockPos
		return pos == blockPos
	})

	if len(a.world.Block(blockBehind).Model().BBox(blockBehind, a.world)) != 0 {
		return blockBehind, true
	}

	// brute force search.
	for _, face := range cube.Faces() {
		blockPos := pos.Side(face)
		if len(a.world.Block(blockPos).Model().BBox(blockPos, a.world)) != 0 {
			return blockPos, true
		}
	}
	return cube.Pos{}, false
}

// AbleToInteractWithBlock returns whether Actor is able to interact with block.
func (a *Actor) AbleToInteractWithBlock(bl w.Block, pos cube.Pos) (clickPos mgl64.Vec3, err error) {
	eyePos := a.EyePos()

	var limit = 6.0
	if a.Gamemode() == 1 {
		limit = 12
	}

	var distanceSquared = math.MaxFloat64
	var resultPos mgl64.Vec3
	for _, box := range bl.Model().BBox(pos, a.world) {
		p := mcmath.NearestPosOnBox(box.Translate(pos.Vec3()), eyePos)
		l := p.Sub(eyePos).LenSqr()
		if distanceSquared > l {
			distanceSquared = l
			resultPos = p
		}
	}
	if math.Sqrt(distanceSquared) > limit {
		return mgl64.Vec3{}, ErrToFarAway{bl}
	}
	return resultPos.Sub(pos.Vec3()), nil
}

// AbleToInteractWithEntity returns whether Actor is able to interact with entity.
func (a *Actor) AbleToInteractWithEntity(e world.Entity) (clickPos mgl64.Vec3, err error) {
	eyePos := a.EyePos()
	resultPos := mcmath.NearestPosOnBox(e.State().Box().Translate(e.Position()), eyePos)

	var limit = 3.0
	if a.Gamemode() == 1 {
		limit = 5
	}

	if resultPos.Sub(eyePos).Len() > limit {
		return mgl64.Vec3{}, ErrToFarAway{e}
	}
	return resultPos.Sub(e.Position()), nil
}

// PickBlock tries to pick block.
func (a *Actor) PickBlock(pos cube.Pos, slot int, addNbt bool) error {
	if a.Gamemode() != 1 {
		return ErrGamemodeRequired{
			Action:           "PickBlock",
			RequiredGamemode: w.GameModeCreative,
		}
	}

	return a.conn.WritePacket(&packet.BlockPickRequest{
		Position:    posToProtocol(pos),
		AddBlockNBT: addNbt,
		HotBarSlot:  byte(slot),
	})
}

// PickActor tries to pick entity.
func (a *Actor) PickActor(ent world.Entity, slot int, includeData bool) error {
	if a.Gamemode() != 1 {
		return ErrGamemodeRequired{
			Action:           "PickActor",
			RequiredGamemode: w.GameModeCreative,
		}
	}

	return a.conn.WritePacket(&packet.ActorPickRequest{
		EntityUniqueID: int64(ent.RuntimeID()),
		HotBarSlot:     byte(slot),
		WithData:       includeData,
	})
}

// EditBook edits BookAndQuill.
func (a *Actor) EditBook(action BookAction, slot int) error {
	it, err := a.Inventory().Item(slot)
	if err != nil {
		return err
	}
	if it.Empty() {
		return fmt.Errorf("item is empty")
	}
	book, ok := it.Item().(item.BookAndQuill)
	if !ok {
		return fmt.Errorf("item is not BookAndQuill")
	}

	pk, err := action.Perform(book, a)
	if err != nil {
		return err
	}
	pk.InventorySlot = byte(slot)
	return a.conn.WritePacket(pk)
}

// OpenContainer ...
func (a *Actor) OpenContainer(container *Container) {
	if a.container != nil || !a.container.closed {
		_ = a.container.Close()
	}
	a.container = container
}

// CurrentContainer returns current opened container.
func (a *Actor) CurrentContainer() (*Container, bool) {
	if a.container != nil || !a.container.closed {
		return nil, false
	}
	return a.container, true
}

// ToggleCrafterSlot enables or disables crafter slot.
func (a *Actor) ToggleCrafterSlot(pos cube.Pos, slot int, disabled bool) error {
	bl := a.world.Block(pos)
	if name, _ := bl.EncodeBlock(); name != "minecraft:crafter" {
		return fmt.Errorf("block %s is not minecraft:crafter", name)
	}
	return a.conn.WritePacket(&packet.PlayerToggleCrafterSlotRequest{
		PosX:     int32(pos.X()),
		PosY:     int32(pos.Y()),
		PosZ:     int32(pos.Z()),
		Slot:     byte(slot),
		Disabled: disabled,
	})
}

//go:linkname skinToProtocol github.com/df-mc/dragonfly/server/player/skin.skinToProtocol
func skinToProtocol(s skin.Skin) protocol.Skin

// posToProtocol ...
func posToProtocol(pos cube.Pos) protocol.BlockPos {
	return protocol.BlockPos{int32(pos[0]), int32(pos[1]), int32(pos[2])}
}
