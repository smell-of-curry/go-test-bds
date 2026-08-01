package bot

import (
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// Bot handles server packets and Actor's actions.
type Bot struct {
	a         *actor.Actor
	closed    chan struct{}
	closeOnce sync.Once
	conn      Conn

	handlers                  map[uint32]packetHandler
	tasks                     chan task
	pendingItemStackResponses map[int32]*inventory.History

	currentRequestID int32

	currentContainerID uint32
	currentContainer   *actor.Container

	packets chan packet.Packet
	logger  *slog.Logger

	// chatOut carries outbound status chat off the tick loop (see EnqueueChat).
	chatOut chan string

	chunks chunkHealth
}

// NewBot ...
func NewBot(conn Conn, logger *slog.Logger) *Bot {
	bot := &Bot{
		closed:                    make(chan struct{}),
		conn:                      conn,
		handlers:                  make(map[uint32]packetHandler),
		tasks:                     make(chan task, 256),
		pendingItemStackResponses: make(map[int32]*inventory.History),
		packets:                   make(chan packet.Packet, 256),
		chatOut:                   make(chan string, chatOutBuf),
		logger:                    logger,
	}
	bot.a = actor.Config{
		Conn:      conn,
		Inventory: inventory.NewHandle(36, protocol.ContainerInventory, bot),
		Offhand:   inventory.NewHandle(1, protocol.ContainerOffhand, bot),
		Armour:    inventory.NewArmour(bot),
		Ui:        inventory.NewHandle(54, protocol.ContainerCursor, bot),
	}.New()
	bot.registerHandlers()

	return bot
}

// Close stops the tick loop, which disconnects the bot.
//
// Safe to call more than once and from any goroutine: shutdown races with the
// loop ending on its own, and a second close of the channel would panic.
//
// @returns nil, always.
func (b *Bot) Close() error {
	b.closeOnce.Do(func() { close(b.closed) })
	return nil
}

// Closed is closed when Close has been called (or the tick loop is shutting down).
//
// @returns a receive-only channel that closes on shutdown.
func (b *Bot) Closed() <-chan struct{} {
	return b.closed
}

// maxPriorityTicks bounds how many due ticks are taken back-to-back before the
// loop must offer packets and tasks a turn. When a tick itself runs longer than
// the tick interval, the ticker is due again the moment it returns; an
// unbounded priority path then degenerates into ticking forever — the tick
// counters look perfectly healthy while every inbound packet (and with them
// every test instruction) starves without a single warning. Seen live as a bot
// that answers forms all run and then goes permanently silent the moment the
// world grows expensive enough to push a tick past 50ms.
const maxPriorityTicks = 3

// StartTickLoop starts handling loop.
//
// The tick is what makes the bot a client: physics, navigation and every timeout
// expressed in ticks run off it. A due tick is therefore taken before anything
// else — `select` picks at random between ready cases, and `time.Ticker` drops
// ticks rather than queueing them, so a busy packet queue would otherwise cost
// simulated time with nothing to show it happened. The priority is bounded by
// maxPriorityTicks so an over-budget tick cannot starve I/O forever.
func (b *Bot) StartTickLoop() {
	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	defer b.conn.Close()
	defer b.a.Close()

	go b.handlePackets()
	b.startChatWriter()

	var health tickHealth
	health.watchStalls(b.logger, b.closed)
	priorityTicks := 0
	for {
		now := time.Now()
		health.report(b.logger, now)
		b.chunks.report(b.logger, b.a, now)

		if priorityTicks < maxPriorityTicks {
			select {
			case <-b.closed:
				return
			case <-ticker.C:
				b.a.Tick()
				health.tick()
				priorityTicks++
				continue
			default:
			}
		}
		priorityTicks = 0

		select {
		case <-b.closed:
			return
		case <-ticker.C:
			b.a.Tick()
			health.tick()
		case t := <-b.tasks:
			t.fn(b.a)
			close(t.done)
		case pk := <-b.packets:
			start := time.Now()
			b.HandlePacket(pk)
			health.packet(pk, time.Since(start))
		}
	}
}

// Execute - executes fn on the Actor.
//
// Blocks until the task is queued (or the bot is closed). Callers that must not
// wait on a saturated queue should use TryExecute.
func (b *Bot) Execute(fn func(*actor.Actor)) chan struct{} {
	done := make(chan struct{})
	select {
	case <-b.closed:
		close(done)
		return done
	case b.tasks <- task{fn: fn, done: done}:
		return done
	}
}

// TryExecute queues fn without blocking. Returns false when the task buffer is
// full or the bot is closed (fn is not run).
//
// @param fn Work to run on the tick loop.
// @returns true when the task was queued.
func (b *Bot) TryExecute(fn func(*actor.Actor)) bool {
	done := make(chan struct{})
	select {
	case <-b.closed:
		return false
	case b.tasks <- task{fn: fn, done: done}:
		return true
	default:
		return false
	}
}

// Conn returns network connection.
func (b *Bot) Conn() Conn {
	return b.conn
}

// handlePackets ...
func (b *Bot) handlePackets() {
	for {
		pk, err := b.conn.ReadPacket()
		if err != nil {
			_ = b.Close()
			return
		}
		b.packets <- pk
	}
}

// HandlePacket handles incoming packet.
func (b *Bot) HandlePacket(pk packet.Packet) {
	handler, ok := b.handlers[pk.ID()]
	if !ok {
		b.logger.Debug("unhandled packet", "packet", fmt.Sprintf("%T", pk))
		return
	}

	// there is no need to call Bot.Execute() as it is running in the same goroutine anyway.
	err := handler.Handle(pk, b, b.a)
	if err != nil {
		b.logger.Error("error handling packet",
			"packet", fmt.Sprintf("%T", pk),
			"error", err,
		)
	}
}

// registerHandlers registers all packet handlers.
func (b *Bot) registerHandlers() {
	b.handlers = map[uint32]packetHandler{
		packet.IDAddActor:                    &AddEntityHandler{},
		packet.IDAddItemActor:                &AddEntityHandler{},
		packet.IDAddPlayer:                   &AddEntityHandler{},
		packet.IDLevelChunk:                  &LevelChunkHandler{},
		packet.IDSubChunk:                    &SubChunkHandler{},
		packet.IDUpdateBlock:                 &UpdateBlockHandler{},
		packet.IDUpdateSubChunkBlocks:        &UpdateSubChunkBlocksHandler{},
		packet.IDSetActorData:                &SetActorDataHandler{},
		packet.IDSetActorMotion:              &SetActorMotionHandler{},
		packet.IDMoveActorAbsolute:           &MoveActorAbsoluteHandler{},
		packet.IDMovePlayer:                  &MovePlayerHandler{},
		packet.IDInventoryContent:            &InventoryContentHandler{},
		packet.IDInventorySlot:               &InventorySlotHandler{},
		packet.IDItemStackResponse:           &ItemStackResponseHandler{},
		packet.IDMobEffect:                   &MobEffectHandler{},
		packet.IDUpdateAttributes:            &UpdateAttributesHandler{},
		packet.IDCorrectPlayerMovePrediction: &CorrectPlayerMovePredictionHandler{},
		packet.IDRemoveActor:                 &RemoveActorHandler{},
		packet.IDActorEvent:                  &ActorEventHandler{},
		packet.IDAnimate:                     &AnimateHandler{},
		packet.IDChangeDimension:             &ChangeDimensionHandler{},
		packet.IDChunkRadiusUpdated:          &ChunkRadiusUpdatedHandler{},
		packet.IDNetworkChunkPublisherUpdate: &NetworkChunkPublisherUpdateHandler{},
		packet.IDModalFormRequest:            &ModalFormRequestHandler{},
		packet.IDText:                        &TextHandler{},
		packet.IDSetTitle:                    &SetTitleHandler{},
		packet.IDSetTime:                     &SetTimeHandler{},
		packet.IDSpawnParticleEffect:         &SpawnParticleEffectHandler{},
		packet.IDCameraPresets:               &CameraPresetsHandler{},
		packet.IDCameraInstruction:           &CameraInstructionHandler{},
		packet.IDMobArmourEquipment:          &MobArmourEquipmentHandler{},
		packet.IDMobEquipment:                &MobEquipmentHandler{},
		packet.IDBlockActorData:              &BlockActorDataHandler{},
		packet.IDOpenSign:                    &OpenSignHandler{},
		packet.IDNPCDialogue:                 &NpcDialogueHandler{},
		packet.IDContainerOpen:               &ContainerOpenHandler{},
		packet.IDCommandOutput:               &CommandOutputHandler{},
		packet.IDItemRegistry:                &ItemRegistryHandler{},
		packet.IDSyncActorProperty:           &SyncActorPropertyHandler{},
	}
}

// task ...
type task struct {
	fn   func(a *actor.Actor)
	done chan struct{}
}
