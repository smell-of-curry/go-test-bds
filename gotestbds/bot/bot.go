package bot

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// Bot handles server packets and Actor's actions.
type Bot struct {
	a      *actor.Actor
	closed chan struct{}
	conn   Conn

	handlers                  map[uint32]packetHandler
	tasks                     chan task
	pendingItemStackResponses map[int32]*inventory.History

	currentRequestID int32

	currentContainerID uint32
	currentContainer   *actor.Container

	packets chan packet.Packet
	logger  *slog.Logger
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

// Close ...
func (b *Bot) Close() error {
	close(b.closed)
	return nil
}

// StartTickLoop starts handling loop.
func (b *Bot) StartTickLoop() {
	ticker := time.NewTicker(time.Second / 20)

	defer b.conn.Close()
	defer b.a.Close()

	go b.handlePackets()

	for {
		select {
		case <-b.closed:
			return
		case <-ticker.C:
			b.a.Tick()
		case t := <-b.tasks:
			t.fn(b.a)
			close(t.done)
		case pk := <-b.packets:
			b.HandlePacket(pk)
		}
	}
}

// Execute - executes fn on the Actor.
func (b *Bot) Execute(fn func(*actor.Actor)) chan struct{} {
	done := make(chan struct{})
	b.tasks <- task{
		fn:   fn,
		done: done,
	}
	return done
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
		packet.IDSetActorData:                &SetActorDataHandler{},
		packet.IDSetActorMotion:              &SetActorMotionHandler{},
		packet.IDMoveActorAbsolute:           &MoveActorAbsoluteHandler{},
		packet.IDInventoryContent:            &InventoryContentHandler{},
		packet.IDInventorySlot:               &InventorySlotHandler{},
		packet.IDItemStackResponse:           &ItemStackResponseHandler{},
		packet.IDMobEffect:                   &MobEffectHandler{},
		packet.IDUpdateAttributes:            &UpdateAttributesHandler{},
		packet.IDCorrectPlayerMovePrediction: &CorrectPlayerMovePredictionHandler{},
		packet.IDRemoveActor:                 &RemoveActorHandler{},
		packet.IDActorEvent:                  &ActorEventHandler{},
		packet.IDChunkRadiusUpdated:          &ChunkRadiusUpdatedHandler{},
		packet.IDNetworkChunkPublisherUpdate: &NetworkChunkPublisherUpdateHandler{},
		packet.IDModalFormRequest:            &ModalFormRequestHandler{},
		packet.IDText:                        &TextHandler{},
		packet.IDMobArmourEquipment:          &MobArmourEquipmentHandler{},
		packet.IDMobEquipment:                &MobEquipmentHandler{},
		packet.IDBlockActorData:              &BlockActorDataHandler{},
		packet.IDOpenSign:                    &OpenSignHandler{},
		packet.IDNPCDialogue:                 &NpcDialogueHandler{},
		packet.IDContainerOpen:               &ContainerOpenHandler{},
		packet.IDCommandOutput:               &CommandOutputHandler{},
	}
}

// task ...
type task struct {
	fn   func(a *actor.Actor)
	done chan struct{}
}
