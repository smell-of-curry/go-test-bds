package viewer

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/item"
	dfworld "github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	gw "github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// encoder projects World/Actor into schema v1 frames.
//
// It is owned by a Stream and used only from the bot goroutine. HTTP never
// touches it: Tick encodes once, fans out the resulting bytes, and shares them
// with every subscriber.
type encoder struct {
	botName string
	radius  int

	blockCache map[uint32]Block
	prev       *viewState
	forceKey   bool
}

// viewState is the last fully projected snapshot, used to build deltas.
type viewState struct {
	world    World
	columns  map[[2]int32]Column
	entities map[uint64]Entity
	actor    Actor
	uiBytes  []byte
	tick     uint64
}

func newEncoder(botName string, radius int) *encoder {
	if radius < 0 {
		radius = 0
	}
	return &encoder{
		botName:    botName,
		radius:     radius,
		blockCache: make(map[uint32]Block),
	}
}

// DimensionChanged forces the next Tick to emit a keyframe.
func (e *encoder) DimensionChanged() {
	e.forceKey = true
}

// frame encodes one tick. Returns the SSE event name and JSON payload bytes.
func (e *encoder) frame(a *actor.Actor) (event string, payload []byte, err error) {
	cur, err := e.project(a)
	if err != nil {
		return "", nil, err
	}
	if e.prev == nil || e.forceKey {
		e.forceKey = false
		e.prev = cur
		kf := Keyframe{
			V:        SchemaVersion,
			Type:     "keyframe",
			Bot:      e.botName,
			Tick:     cur.tick,
			World:    cur.world,
			Actor:    cur.actor,
			Columns:  columnsSlice(cur.columns),
			Entities: entitiesSlice(cur.entities),
			UI:       mustDecodeUI(cur.uiBytes),
		}
		b, err := json.Marshal(kf)
		return "keyframe", b, err
	}

	d := e.delta(cur)
	e.prev = cur
	b, err := json.Marshal(d)
	return "delta", b, err
}

// project builds a full viewState from the live Actor/World.
func (e *encoder) project(a *actor.Actor) (*viewState, error) {
	w := a.World()
	pos := a.Position()
	cx, cz := int32(math.Floor(pos.X()))>>4, int32(math.Floor(pos.Z()))>>4

	worldMeta := World{
		Dimension:     a.Dimension(),
		DimensionName: dimensionName(a.Dimension()),
	}
	r := w.Columns()
	// min/max Y come from any column in radius; fall back to overworld range.
	worldMeta.MinY, worldMeta.MaxY = -64, 319
	columns := make(map[[2]int32]Column)
	for cpos, col := range r {
		// Chebyshev radius matches chunk-radius style caps used by the bot.
		if chebyshev(cpos[0]-cx, cpos[1]-cz) > e.radius {
			continue
		}
		enc := e.encodeColumn(w, cpos, col)
		columns[[2]int32{cpos[0], cpos[1]}] = enc
		worldMeta.MinY = enc.MinY
		worldMeta.MaxY = enc.MaxY
	}

	entities := make(map[uint64]Entity)
	for ent := range w.Entities() {
		entities[ent.RuntimeID()] = e.encodeEntity(ent)
	}

	act := e.encodeActor(a)
	ui := e.encodeUI(a)
	uiBytes, err := json.Marshal(ui)
	if err != nil {
		return nil, err
	}

	return &viewState{
		world:    worldMeta,
		columns:  columns,
		entities: entities,
		actor:    act,
		uiBytes:  uiBytes,
		tick:     a.CurrentTick(),
	}, nil
}

func chebyshev(dx, dz int32) int {
	ax, az := dx, dz
	if ax < 0 {
		ax = -ax
	}
	if az < 0 {
		az = -az
	}
	if ax > az {
		return int(ax)
	}
	return int(az)
}

func (e *encoder) delta(cur *viewState) Delta {
	d := Delta{
		V:    SchemaVersion,
		Type: "delta",
		Bot:  e.botName,
		Tick: cur.tick,
	}

	if cur.world.Dimension != e.prev.world.Dimension {
		// Dimension change: client drops everything before applying the rest.
		w := cur.world
		d.World = &w
		d.ColumnsAdded = columnsSlice(cur.columns)
		d.EntitiesAdded = entitiesSlice(cur.entities)
		act := cur.actor
		d.Actor = &act
		ui := mustDecodeUI(cur.uiBytes)
		d.UI = &ui
		return d
	}

	// Columns.
	for key, col := range cur.columns {
		prev, ok := e.prev.columns[key]
		if !ok {
			d.ColumnsAdded = append(d.ColumnsAdded, col)
			continue
		}
		if prev.State != col.State {
			d.ColumnsState = append(d.ColumnsState, ColumnState{X: key[0], Z: key[1], State: col.State})
		}
		d.Blocks = append(d.Blocks, diffBlocks(key, prev, col)...)
	}
	for key := range e.prev.columns {
		if _, ok := cur.columns[key]; !ok {
			d.ColumnsRemoved = append(d.ColumnsRemoved, key)
		}
	}

	// Entities.
	for rid, ent := range cur.entities {
		prev, ok := e.prev.entities[rid]
		if !ok {
			d.EntitiesAdded = append(d.EntitiesAdded, ent)
			continue
		}
		if !entityEqual(prev, ent) {
			d.EntitiesUpdated = append(d.EntitiesUpdated, ent)
		}
	}
	for rid := range e.prev.entities {
		if _, ok := cur.entities[rid]; !ok {
			d.EntitiesRemoved = append(d.EntitiesRemoved, rid)
		}
	}

	act := cur.actor
	d.Actor = &act

	if !bytes.Equal(cur.uiBytes, e.prev.uiBytes) {
		ui := mustDecodeUI(cur.uiBytes)
		d.UI = &ui
	}
	return d
}

// diffBlocks compares two encodings of the same column and returns per-block
// changes. Section omission means air, so a section that appears or disappears
// is expanded into individual air/non-air updates.
func diffBlocks(pos [2]int32, prev, cur Column) []BlockChange {
	type key struct {
		sx, sy, sz, layer int
	}
	prevBlocks := sectionBlockMap(pos, prev)
	curBlocks := sectionBlockMap(pos, cur)
	var out []BlockChange
	seen := make(map[key]struct{})
	for k, b := range curBlocks {
		seen[k] = struct{}{}
		if pb, ok := prevBlocks[k]; ok && blockEqual(pb, b) {
			continue
		}
		out = append(out, BlockChange{
			Pos:   [3]int{int(pos[0])*16 + k.sx, k.sy, int(pos[1])*16 + k.sz},
			Layer: k.layer,
			Block: b,
		})
	}
	for k, b := range prevBlocks {
		if _, ok := seen[k]; ok {
			continue
		}
		// Block vanished into an omitted (air) section.
		_ = b
		out = append(out, BlockChange{
			Pos:   [3]int{int(pos[0])*16 + k.sx, k.sy, int(pos[1])*16 + k.sz},
			Layer: k.layer,
			Block: airBlock(),
		})
	}
	return out
}

func sectionBlockMap(colPos [2]int32, col Column) map[struct{ sx, sy, sz, layer int }]Block {
	_ = colPos
	out := make(map[struct{ sx, sy, sz, layer int }]Block)
	for _, sec := range col.Sections {
		baseY := sec.Y * 16
		applyLayer := func(b64 string, layer int) {
			if b64 == "" {
				return
			}
			raw, err := base64.StdEncoding.DecodeString(b64)
			if err != nil || len(raw) != 4096*2 {
				return
			}
			for i := 0; i < 4096; i++ {
				idx := binary.LittleEndian.Uint16(raw[i*2:])
				if int(idx) >= len(sec.Palette) {
					continue
				}
				x := (i >> 8) & 0xf
				z := (i >> 4) & 0xf
				y := i & 0xf
				out[struct{ sx, sy, sz, layer int }{x, baseY + y, z, layer}] = sec.Palette[idx]
			}
		}
		applyLayer(sec.Blocks, 0)
		applyLayer(sec.Blocks1, 1)
	}
	return out
}

func (e *encoder) encodeColumn(w *gw.World, pos dfworld.ChunkPos, col *gw.Column) Column {
	r := col.Range()
	out := Column{
		X:     pos[0],
		Z:     pos[1],
		State: col.State.String(),
		MinY:  r[0],
		MaxY:  r[1],
	}
	subs := col.Sub()
	for i, sub := range subs {
		if sub == nil || sub.Empty() {
			continue
		}
		// PROTOCOL section y is the section index (covers y*16 .. y*16+15).
		secY := int(col.SubY(int16(i))) >> 4
		sec, ok := e.encodeSection(w, sub, secY)
		if ok {
			out.Sections = append(out.Sections, sec)
		}
	}
	return out
}

// encodeSection builds one wire Section. Returns ok=false for air-only.
//
// blocks is base64 of 4096 little-endian uint16 palette indices ordered
// index = (x << 8) | (z << 4) | y — Bedrock's own sub-chunk order, so the
// encoder is a straight triple loop with no swizzle.
func (e *encoder) encodeSection(w *gw.World, sub *chunk.SubChunk, secY int) (Section, bool) {
	layers := sub.Layers()
	if len(layers) == 0 {
		return Section{}, false
	}
	sec, airOnly := e.encodeLayer(w, sub, 0)
	if airOnly {
		return Section{}, false
	}
	sec.Y = secY
	if len(layers) > 1 {
		if _, layer1Air := e.encodeLayer(w, sub, 1); !layer1Air {
			// Layer 1 shares no palette with layer 0 on the wire; PROTOCOL
			// puts both indices into the same section palette. Rebuild with
			// a unified palette covering both layers.
			return e.encodeSectionUnified(w, sub, secY)
		}
	}
	return sec, true
}

func (e *encoder) encodeLayer(w *gw.World, sub *chunk.SubChunk, layer uint8) (Section, bool) {
	var palette []Block
	indexOf := map[uint32]uint16{}
	raw := make([]byte, 4096*2)
	airOnly := true
	airRID := dfworld.DefaultBlockRegistry.AirRuntimeID()

	for x := 0; x < 16; x++ {
		for z := 0; z < 16; z++ {
			for y := 0; y < 16; y++ {
				rid := sub.Block(byte(x), byte(y), byte(z), layer)
				if rid != airRID {
					airOnly = false
				}
				idx, ok := indexOf[rid]
				if !ok {
					idx = uint16(len(palette))
					indexOf[rid] = idx
					palette = append(palette, e.blockFromRID(w, rid))
				}
				off := (x << 8) | (z << 4) | y
				binary.LittleEndian.PutUint16(raw[off*2:], idx)
			}
		}
	}
	if airOnly {
		return Section{}, true
	}
	sec := Section{Palette: palette}
	if layer == 0 {
		sec.Blocks = base64.StdEncoding.EncodeToString(raw)
	} else {
		sec.Blocks1 = base64.StdEncoding.EncodeToString(raw)
	}
	return sec, false
}

func (e *encoder) encodeSectionUnified(w *gw.World, sub *chunk.SubChunk, secY int) (Section, bool) {
	var palette []Block
	indexOf := map[uint32]uint16{}
	raw0 := make([]byte, 4096*2)
	raw1 := make([]byte, 4096*2)
	airRID := dfworld.DefaultBlockRegistry.AirRuntimeID()
	layer0Air, layer1Air := true, true

	lookup := func(rid uint32) uint16 {
		idx, ok := indexOf[rid]
		if ok {
			return idx
		}
		idx = uint16(len(palette))
		indexOf[rid] = idx
		palette = append(palette, e.blockFromRID(w, rid))
		return idx
	}

	for x := 0; x < 16; x++ {
		for z := 0; z < 16; z++ {
			for y := 0; y < 16; y++ {
				off := (x << 8) | (z << 4) | y
				rid0 := sub.Block(byte(x), byte(y), byte(z), 0)
				if rid0 != airRID {
					layer0Air = false
				}
				binary.LittleEndian.PutUint16(raw0[off*2:], lookup(rid0))

				rid1 := sub.Block(byte(x), byte(y), byte(z), 1)
				if rid1 != airRID {
					layer1Air = false
				}
				binary.LittleEndian.PutUint16(raw1[off*2:], lookup(rid1))
			}
		}
	}
	if layer0Air {
		return Section{}, false
	}
	sec := Section{
		Y:       secY,
		Palette: palette,
		Blocks:  base64.StdEncoding.EncodeToString(raw0),
	}
	if !layer1Air {
		sec.Blocks1 = base64.StdEncoding.EncodeToString(raw1)
	}
	return sec, true
}

// blockFromRID resolves a network runtime ID to a wire Block.
//
// A registry miss keeps name empty and the non-zero rid — do not invent a name
// (UnknownBlock's gotestbds:unknown is for physics/assertions, not the wire).
func (e *encoder) blockFromRID(w *gw.World, networkRID uint32) Block {
	if b, ok := e.blockCache[networkRID]; ok {
		return b
	}
	local := w.DecodeNetworkRuntimeID(networkRID)
	bl, ok := dfworld.BlockByRuntimeID(local)
	if !ok {
		b := Block{Name: "", States: map[string]any{}, RID: networkRID}
		e.blockCache[networkRID] = b
		return b
	}
	name, states := bl.EncodeBlock()
	if states == nil {
		states = map[string]any{}
	}
	b := Block{Name: name, States: states, RID: networkRID}
	e.blockCache[networkRID] = b
	return b
}

func airBlock() Block {
	rid := dfworld.DefaultBlockRegistry.AirRuntimeID()
	name, states := block.Air{}.EncodeBlock()
	if states == nil {
		states = map[string]any{}
	}
	return Block{Name: name, States: states, RID: rid}
}

func (e *encoder) encodeEntity(ent gw.Entity) Entity {
	pos := ent.Position()
	rot := ent.Rotation()
	vel := ent.Velocity()
	st := ent.State()
	box := st.Box()
	main, off := ent.HeldItems()
	attrs := ent.Attributes()
	out := Entity{
		RID:    ent.RuntimeID(),
		UID:    ent.UniqueID(),
		Type:   ent.Type(),
		Pos:    [3]float64{pos.X(), pos.Y(), pos.Z()},
		Rot:    []float64{rot.Yaw(), rot.Pitch()},
		Vel:    [3]float64{vel.X(), vel.Y(), vel.Z()},
		BBox:   [2]float64{box.Width(), box.Height()},
		Name:   st.NameTag(),
		Player: ent.Type() == "minecraft:player",
		Flags:  st.Flags(),
		Props:  st.Props(),
		Attributes: map[string]float64{
			"health":    attrs.Health(),
			"maxHealth": attrs.MaxHealth(),
		},
		Held: HeldItems{
			Main: itemPtr(main),
			Off:  itemPtr(off),
		},
		Armour: armourSlots(ent.Armour()),
	}
	if out.Props == nil {
		out.Props = map[string]any{}
	}
	return out
}

func (e *encoder) encodeActor(a *actor.Actor) Actor {
	pos := a.Position()
	eye := a.EyePos()
	rot := a.Rotation()
	vel := a.Velocity()
	out := Actor{
		RID:         a.RuntimeID(),
		UID:         a.UniqueID(),
		Name:        a.Name(),
		Pos:         [3]float64{pos.X(), pos.Y(), pos.Z()},
		EyePos:      [3]float64{eye.X(), eye.Y(), eye.Z()},
		Rot:         []float64{rot.Yaw(), rot.Pitch()},
		Vel:         [3]float64{vel.X(), vel.Y(), vel.Z()},
		OnGround:    a.OnGround(),
		Gamemode:    a.Gamemode(),
		Dimension:   a.Dimension(),
		Health:      a.Health(),
		MaxHealth:   a.MaxHealth(),
		Food:        a.Attributes().Food(),
		HeldSlot:    a.HeldSlot(),
		Sneaking:    a.Sneaking(),
		Sprinting:   a.Sprinting(),
		Swimming:    a.Swimming(),
		Gliding:     a.Gliding(),
		Hotbar:      slotRange(a.Inventory(), 0, 9),
		Inventory:   slotRange(a.Inventory(), 0, 36),
		Offhand:     slotAt(a.Offhand(), 0),
		Armour:      armourSlots(a.Armour()),
		Effects:     encodeEffects(a),
		ChunkRadius: a.ChunkRadius(),
	}
	if la := e.lookingAt(a); la != nil {
		out.LookingAt = la
	}
	return out
}

func (e *encoder) lookingAt(a *actor.Actor) *LookingAt {
	bl, pos, face := a.BlockFromViewDirection()
	if _, isAir := bl.(block.Air); isAir {
		return nil
	}
	rid, ok := a.World().NetworkBlockRuntimeID(pos, 0)
	var b Block
	if ok {
		b = e.blockFromRID(a.World(), rid)
	} else {
		name, states := bl.EncodeBlock()
		if states == nil {
			states = map[string]any{}
		}
		// Registry-named blocks that EncodeBlock already answers: keep the
		// name. UnknownBlock names itself for physics; the wire rule still
		// wants an empty name when the registry cannot resolve the rid.
		if _, unk := bl.(gw.UnknownBlock); unk {
			name = ""
		}
		b = Block{Name: name, States: states, RID: rid}
	}
	return &LookingAt{
		Pos:   [3]int{pos.X(), pos.Y(), pos.Z()},
		Face:  face.String(),
		Block: b,
	}
}

func (e *encoder) encodeUI(a *actor.Actor) UI {
	ui := UI{}
	if f, ok := a.LastForm(); ok {
		ui.Form = &UIForm{
			Type:    formTypeName(f.Type()),
			Title:   f.Title(),
			Content: f.ContentText(),
			Buttons: formButtons(f),
		}
	}
	if c, ok := a.CurrentContainer(); ok {
		ui.Container = &UIContainer{
			Type:  c.TypeName(),
			Slots: allSlots(c.Inventory()),
		}
	}
	if s, ok := a.LastSign(); ok {
		front, back := s.Lines()
		ui.Sign = &UISign{Front: front, Back: back}
	}
	if d, ok := a.LastDialogue(); ok {
		buttons := make([]string, 0, len(d.Buttons()))
		for _, b := range d.Buttons() {
			buttons = append(buttons, b.Text())
		}
		ui.Dialogue = &UIDialogue{
			NPCName: d.Title(),
			Text:    d.Text(),
			Buttons: buttons,
		}
	}
	for _, m := range a.RecentMessages(20) {
		ui.Messages = append(ui.Messages, m.Text)
	}
	return ui
}

func formTypeName(t actor.FormType) string {
	switch t {
	case actor.FormTypeMenu:
		return "menu"
	case actor.FormTypeModal:
		return "modal"
	case actor.FormTypeCustom:
		return "custom"
	default:
		return string(t)
	}
}

func formButtons(f *actor.Form) []string {
	if buttons, ok := f.MenuFormButtons(); ok {
		out := make([]string, len(buttons))
		for i, b := range buttons {
			out[i] = b.Text()
		}
		return out
	}
	if yes, no, ok := f.ModalFormButtons(); ok {
		return []string{yes.Text(), no.Text()}
	}
	return nil
}

func encodeEffects(a *actor.Actor) []Effect {
	var out []Effect
	for eff := range a.Effects() {
		name := effectName(eff.Type())
		out = append(out, Effect{
			Name:       name,
			Level:      eff.Level(),
			DurationMs: eff.Duration().Milliseconds(),
		})
	}
	return out
}

func effectName(t any) string {
	name := reflect.TypeOf(t).Name()
	if name == "" {
		name = fmt.Sprintf("%T", t)
	}
	name = strings.TrimPrefix(name, "*")
	if i := strings.LastIndex(name, "."); i >= 0 {
		name = name[i+1:]
	}
	return "minecraft:" + strings.ToLower(name)
}

func itemPtr(s item.Stack) *Item {
	if s.Empty() {
		return nil
	}
	name, _ := s.Item().EncodeItem()
	it := &Item{Name: name, Count: s.Count()}
	if max := s.MaxDurability(); max > 0 {
		dmg := max - s.Durability()
		if dmg > 0 {
			it.Damage = dmg
		}
	}
	if cn := s.CustomName(); cn != "" {
		it.CustomName = cn
	}
	return it
}

func armourSlots(a interface {
	Helmet() item.Stack
	Chestplate() item.Stack
	Leggings() item.Stack
	Boots() item.Stack
}) []*Item {
	return []*Item{
		itemPtr(a.Helmet()),
		itemPtr(a.Chestplate()),
		itemPtr(a.Leggings()),
		itemPtr(a.Boots()),
	}
}

func slotRange(h interface {
	Item(int) (item.Stack, error)
}, from, n int) []*Item {
	out := make([]*Item, n)
	for i := 0; i < n; i++ {
		out[i] = slotAt(h, from+i)
	}
	return out
}

func slotAt(h interface {
	Item(int) (item.Stack, error)
}, slot int) *Item {
	s, err := h.Item(slot)
	if err != nil {
		return nil
	}
	return itemPtr(s)
}

func allSlots(h interface {
	Size() int
	Item(int) (item.Stack, error)
}) []*Item {
	return slotRange(h, 0, h.Size())
}

func dimensionName(dim int32) string {
	switch dim {
	case 0:
		return "overworld"
	case 1:
		return "nether"
	case 2:
		return "end"
	default:
		return fmt.Sprintf("custom:%d", dim)
	}
}

func columnsSlice(m map[[2]int32]Column) []Column {
	out := make([]Column, 0, len(m))
	for _, c := range m {
		out = append(out, c)
	}
	return out
}

func entitiesSlice(m map[uint64]Entity) []Entity {
	out := make([]Entity, 0, len(m))
	for _, e := range m {
		out = append(out, e)
	}
	return out
}

func mustDecodeUI(b []byte) UI {
	var ui UI
	_ = json.Unmarshal(b, &ui)
	return ui
}

func blockEqual(a, b Block) bool {
	if a.RID != b.RID || a.Name != b.Name {
		return false
	}
	ab, _ := json.Marshal(a.States)
	bb, _ := json.Marshal(b.States)
	return bytes.Equal(ab, bb)
}

func entityEqual(a, b Entity) bool {
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return bytes.Equal(ab, bb)
}

// encodeSectionForTest exposes section encoding for the palette-order test.
func encodeSectionForTest(w *gw.World, sub *chunk.SubChunk, secY int) (Section, bool) {
	e := newEncoder("test", 4)
	return e.encodeSection(w, sub, secY)
}
