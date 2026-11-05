package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

type BossEventHandler struct{}

func (*BossEventHandler) Handle(p packet.Packet, _ *Bot, a *actor.Actor) error {
	a.ApplyBossEvent(p.(*packet.BossEvent))
	return nil
}
