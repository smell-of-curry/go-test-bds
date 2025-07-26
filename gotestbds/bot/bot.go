package bot

import (
	"github.com/df-mc/dragonfly/server/item/inventory"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"log/slog"
	"time"
)

// Bot handles server packets and Actor's actions.
type Bot struct {
	a      *actor.Actor
	closed chan struct{}
	conn   *minecraft.Conn

	handlers map[uint32]packetHandler
	tasks    chan func(actor *actor.Actor)

	handlingInventories bool
	ui                  *inventory.Inventory
	inventoryMappings   map[*inventory.Inventory]*inventoryMapping

	packets chan packet.Packet
	logger  *slog.Logger
}

// NewBot ...
func NewBot(conn *minecraft.Conn, logger *slog.Logger) *Bot {
	bot := &Bot{
		a:        actor.NewActor(conn),
		closed:   make(chan struct{}),
		conn:     conn,
		handlers: make(map[uint32]packetHandler),
		tasks:    make(chan func(actor *actor.Actor)),
		packets:  make(chan packet.Packet),
		logger:   logger,
	}
	bot.registerHandlers()
	bot.registerInventoryMappings()
	bot.handleInventories()

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
		case task := <-b.tasks:
			task(b.a)
		case pk := <-b.packets:
			b.handlePacket(pk)
		}
	}
}

// Execute - executes task on the Actor.
func (b *Bot) Execute(task func(*actor.Actor)) {
	b.tasks <- task
}

// Conn ...
func (b *Bot) Conn() *minecraft.Conn {
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

// handleInventories broadcasts inventory actions to the server.
func (b *Bot) handleInventories() {
	for i, mapping := range b.inventoryMappings {
		i.SlotFunc(b.slotFunc(mapping.windowID, i))
	}
}

// handlePacket handles incoming packet.
func (b *Bot) handlePacket(pk packet.Packet) {
	handler, ok := b.handlers[pk.ID()]
	if !ok {
		return
	}

	b.Execute(func(a *actor.Actor) {
		handler.Handle(pk, b, a)
	})
}

// registerHandlers registers all packet handlers.
func (b *Bot) registerHandlers() {
	b.handlers = map[uint32]packetHandler{
		packet.IDAddActor:          &AddEntityHandler{},
		packet.IDAddItemActor:      &AddEntityHandler{},
		packet.IDAddPlayer:         &AddEntityHandler{},
		packet.IDLevelChunk:        &LevelChunkHandler{},
		packet.IDSubChunk:          &SubChunkHandler{},
		packet.IDUpdateBlock:       &UpdateBlockHandler{},
		packet.IDSetActorData:      &SetActorDataHandler{},
		packet.IDSetActorMotion:    &SetActorMotionHandler{},
		packet.IDMoveActorAbsolute: &MoveActorAbsoluteHandler{},
		packet.IDInventoryContent:  &InventoryContentHandler{},
		packet.IDInventorySlot:     &InventorySlotHandler{},
	}
}
