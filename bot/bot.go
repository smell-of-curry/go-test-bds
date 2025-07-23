package bot

import (
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"pokebedrock_testing_bot/bot/actor"
	"time"
)

// Bot handles server packets and Actor's actions.
type Bot struct {
	a      *actor.Actor
	closed chan struct{}

	conn     *minecraft.Conn
	handlers map[uint32]packetHandler

	tasks   chan func(actor *actor.Actor)
	packets chan packet.Packet
}

func NewBot(conn *minecraft.Conn) *Bot {
	return &Bot{
		a:        actor.NewActor(conn),
		closed:   make(chan struct{}),
		conn:     conn,
		handlers: make(map[uint32]packetHandler),
		tasks:    make(chan func(actor *actor.Actor)),
		packets:  make(chan packet.Packet),
	}
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
