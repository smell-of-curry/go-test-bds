package viewer

import (
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
	"testing"
)

func TestHotbarUsesServerItemRegistry(t *testing.T) {
	inv := inventory.NewHandle(36, 0, nil)
	a := actor.Config{Conn: stubConn{game: minecraft.GameData{Items: []protocol.ItemEntry{{Name: "minecraft:compass", RuntimeID: 31001}}}}, Inventory: inv, Offhand: inventory.NewHandle(1, 0, nil), Armour: inventory.NewArmour(nil), Ui: inventory.NewHandle(54, 0, nil)}.New()
	if err := inv.SetItem(8, protocol.ItemInstance{Stack: protocol.ItemStack{ItemType: protocol.ItemType{NetworkID: 31001}, Count: 1}}); err != nil {
		t.Fatal(err)
	}
	slots := collectVitals("Test", a).Hotbar
	if slots[8] == nil || slots[8].TypeID != "minecraft:compass" || slots[8].Count != 1 {
		t.Fatalf("server registry item disappeared: %+v", slots[8])
	}
	if slots[0] != nil {
		t.Fatal("empty slot became an item")
	}
}
func TestBossBarPacketStateReplaysAndClears(t *testing.T) {
	a := testActor(t, "Test")
	h := &bot.BossEventHandler{}
	apply := func(p *packet.BossEvent) {
		t.Helper()
		if err := h.Handle(p, nil, a); err != nil {
			t.Fatal(err)
		}
	}
	apply(&packet.BossEvent{BossEntityUniqueID: 1, EventType: packet.BossEventShow, BossBarTitle: "Queue position: 2", HealthPercentage: 0.5, Colour: packet.BossEventColourPurple})
	ui := newEncoder("Test", 4, 4).encodeUI(a)
	if len(ui.BossBars) != 1 || ui.BossBars[0].Title != "Queue position: 2" {
		t.Fatalf("bar missing from late snapshot: %+v", ui)
	}
	apply(&packet.BossEvent{BossEntityUniqueID: 1, EventType: packet.BossEventTitle, BossBarTitle: "Queue position: 1"})
	apply(&packet.BossEvent{BossEntityUniqueID: 1, EventType: packet.BossEventHealthPercentage, HealthPercentage: 2})
	b := a.BossBars()[0]
	if b.Title != "Queue position: 1" || b.Health != 1 {
		t.Fatal(b)
	}
	apply(&packet.BossEvent{BossEntityUniqueID: 1, EventType: packet.BossEventHide})
	apply(&packet.BossEvent{BossEntityUniqueID: 1, EventType: packet.BossEventTitle, BossBarTitle: "late"})
	if len(a.BossBars()) != 0 {
		t.Fatal("hidden boss bar was recreated by late update")
	}
}
