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
	"github.com/smell-of-curry/go-test-bds/gotestbds/wire"
	gw "github.com/smell-of-curry/go-test-bds/gotestbds/world"

	// Register vanilla biome ids so BiomeByID can name snapshot biomes.
	_ "github.com/df-mc/dragonfly/server/world/biome"
)

// encoder projects World/Actor into schema v1 frames.
//
// It is owned by a Stream and used only from the bot goroutine. HTTP never
// touches it: Tick encodes once, fans out the resulting bytes, and shares them
// with every subscriber.
type encoder struct {
	botName       string
	radius        int
	sectionRadius int
	lightBudget   int

	blockCache map[uint32]Block
	// colCache reuses wire columns whose world Revision has not moved. Cleared
	// on dimension change and whenever the actor's section Y leaves the window
	// the cached encodings were built for.
	colCache     map[[2]int32]colCacheEntry
	cacheCenterY int
	cacheValid   bool

	// skipColCache forces a full re-encode every tick. Benchmarks use it to
	// measure the pre-cache cost without checking out old code.
	skipColCache bool

	prev     *viewState
	forceKey bool
}

type colCacheEntry struct {
	rev uint64
	col Column
}

// lightFillBudget caps light fill/spread operations per snapshot pass. Each
// operation remaps hashed palettes and runs dragonfly light propagation on the
// bot goroutine; an unbounded pass over a freshly streamed city stalled the
// tick loop for tens of seconds and starved instruction responses.
const lightFillBudget = 8

// encoder.lightBudget defaults to lightFillBudget; tests raise it so light
// lands in the first pass and column deltas stay deterministic.

// viewState is the last fully projected snapshot, used to build deltas.
type viewState struct {
	world    World
	columns  map[[2]int32]Column
	revs     map[[2]int32]uint64
	centerX  int32
	centerZ  int32
	centerY  int
	entities map[uint64]Entity
	actor    Actor
	uiBytes  []byte
	tick     uint64
	time     *int32
	camera   *Camera
	camSeq   uint64
}

func newEncoder(botName string, radius, sectionRadius int) *encoder {
	if radius < 0 {
		radius = 0
	}
	if sectionRadius < 0 {
		sectionRadius = 0
	}
	return &encoder{
		botName:       botName,
		radius:        radius,
		sectionRadius: sectionRadius,
		lightBudget:   lightFillBudget,
		blockCache:    make(map[uint32]Block),
		colCache:      make(map[[2]int32]colCacheEntry),
	}
}

// DimensionChanged forces the next Tick to emit a keyframe.
func (e *encoder) DimensionChanged() {
	e.forceKey = true
	clear(e.colCache)
	e.cacheValid = false
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
			V:          SchemaVersion,
			Type:       "keyframe",
			Bot:        e.botName,
			Tick:       cur.tick,
			World:      cur.world,
			Actor:      cur.actor,
			Columns:    columnsSlice(cur.columns),
			Entities:   entitiesSlice(cur.entities),
			UI:         mustDecodeUI(cur.uiBytes),
			Registries: encodeRegistries(a.WireRegistries()),
			Time:       cur.time,
			Camera:     cur.camera,
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
	centerY := int(math.Floor(pos.Y())) >> 4

	// Cached encodings are window-specific; a vertical section change would
	// otherwise leave sections the actor walked away from stuck on the client.
	if !e.cacheValid || centerY != e.cacheCenterY {
		clear(e.colCache)
		e.cacheCenterY = centerY
		e.cacheValid = true
	}

	worldMeta := World{
		Dimension:     a.Dimension(),
		DimensionName: dimensionName(a.Dimension()),
	}
	r := w.Columns()
	// min/max Y come from any column in radius; fall back to overworld range.
	worldMeta.MinY, worldMeta.MaxY = -64, 319
	columns := make(map[[2]int32]Column)
	revs := make(map[[2]int32]uint64)
	seen := make(map[[2]int32]struct{})
	lightFills := 0
	for cpos, col := range r {
		// Chebyshev radius matches chunk-radius style caps used by the bot.
		if chebyshev(cpos[0]-cx, cpos[1]-cz) > e.radius {
			continue
		}
		key := [2]int32{cpos[0], cpos[1]}
		seen[key] = struct{}{}
		// Light fill is debounced here (once per dirty column per snapshot),
		// not on every SetBlock — and budgeted per snapshot: the fill runs on
		// the bot's goroutine, and an unbounded pass over hundreds of freshly
		// streamed columns stalled the tick loop long enough for instructions
		// to miss their status window. Columns over budget stay dirty (and get
		// encoded without light — bright default) until a later snapshot.
		if lightFills < e.lightBudget && w.EnsureColumnLight(cpos) {
			lightFills++
		}
		rev := col.Revision
		if !e.skipColCache {
			if ent, ok := e.colCache[key]; ok && ent.rev == rev {
				columns[key] = ent.col
				revs[key] = rev
				worldMeta.MinY = ent.col.MinY
				worldMeta.MaxY = ent.col.MaxY
				continue
			}
		}
		enc := e.encodeColumn(w, cpos, col, centerY)
		if !e.skipColCache {
			e.colCache[key] = colCacheEntry{rev: rev, col: enc}
		}
		columns[key] = enc
		revs[key] = rev
		worldMeta.MinY = enc.MinY
		worldMeta.MaxY = enc.MaxY
	}
	for key := range e.colCache {
		if _, ok := seen[key]; !ok {
			delete(e.colCache, key)
		}
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

	var timePtr *int32
	if t, ok := a.WorldTime(); ok {
		tt := t
		timePtr = &tt
	}
	cam, camSeq := encodeCamera(a)

	return &viewState{
		world:    worldMeta,
		columns:  columns,
		revs:     revs,
		centerX:  cx,
		centerZ:  cz,
		centerY:  centerY,
		entities: entities,
		actor:    act,
		uiBytes:  uiBytes,
		tick:     a.CurrentTick(),
		time:     timePtr,
		camera:   cam,
		camSeq:   camSeq,
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
		d.Time = cur.time
		d.Camera = cur.camera
		if cur.camera == nil && e.prev.camera != nil {
			d.CameraCleared = true
		}
		return d
	}

	// Columns. Same world revision + same vertical window ⇒ identical wire
	// column (cache hit); skip the section walk. A window move keeps the
	// world revision but must still diff so sections leaving the window
	// become air on the client.
	sameWindow := cur.centerY == e.prev.centerY
	for key, col := range cur.columns {
		prev, ok := e.prev.columns[key]
		if !ok {
			d.ColumnsAdded = append(d.ColumnsAdded, col)
			continue
		}
		if sameWindow && e.prev.revs[key] == cur.revs[key] {
			continue
		}
		if prev.State != col.State {
			d.ColumnsState = append(d.ColumnsState, ColumnState{X: key[0], Z: key[1], State: col.State})
		}
		// Light/biomes ride on Column payloads, not BlockChange. Re-send the
		// column when those fields moved so already-delivered clients update.
		if columnLightOrBiomeChanged(prev, col) {
			d.ColumnsAdded = append(d.ColumnsAdded, col)
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

	if !timeEqual(cur.time, e.prev.time) {
		d.Time = cur.time
	}
	if cur.camSeq != e.prev.camSeq {
		if cur.camera == nil && e.prev.camera != nil {
			d.CameraCleared = true
		} else {
			d.Camera = cur.camera
		}
	}
	return d
}

func timeEqual(a, b *int32) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

// encodeCamera projects the actor's camera override; nil when inactive.
func encodeCamera(a *actor.Actor) (*Camera, uint64) {
	o := a.CameraOverride()
	if !o.Active && o.Fade == nil {
		return nil, o.Seq
	}
	c := &Camera{
		Preset:         o.Preset,
		EaseDurationMs: o.EaseDurationMs,
	}
	if o.Pos != nil {
		p := [3]float64{float64(o.Pos[0]), float64(o.Pos[1]), float64(o.Pos[2])}
		c.Pos = &p
	}
	if o.Rot != nil {
		r := [2]float64{float64(o.Rot[0]), float64(o.Rot[1])}
		c.Rot = &r
	}
	if o.FOV != nil {
		f := float64(*o.FOV)
		c.FOV = &f
	}
	if o.Fade != nil {
		col := [3]uint8{o.Fade.R, o.Fade.G, o.Fade.B}
		c.Fade = &CameraFade{
			FadeInSec:  float64(o.Fade.FadeInSec),
			WaitSec:    float64(o.Fade.WaitSec),
			FadeOutSec: float64(o.Fade.FadeOutSec),
			Colour:     &col,
		}
	}
	return c, o.Seq
}

// diffBlocks compares two encodings of the same column and returns per-block
// changes. Section omission means air, so a section that appears or disappears
// is expanded into individual air/non-air updates.
//
// Sections whose wire payload is byte-identical are skipped — a column revision
// bump from one block change must not re-expand every other section.
func diffBlocks(pos [2]int32, prev, cur Column) []BlockChange {
	prevByY := sectionsByY(prev)
	curByY := sectionsByY(cur)
	var out []BlockChange
	for y, sec := range curByY {
		ps, ok := prevByY[y]
		if ok && sectionWireEqual(ps, sec) {
			continue
		}
		out = append(out, diffSectionBlocks(pos, ps, sec, ok)...)
	}
	for y, ps := range prevByY {
		if _, ok := curByY[y]; ok {
			continue
		}
		out = append(out, diffSectionBlocks(pos, ps, Section{}, true)...)
	}
	return out
}

func sectionsByY(col Column) map[int]Section {
	out := make(map[int]Section, len(col.Sections))
	for _, sec := range col.Sections {
		out[sec.Y] = sec
	}
	return out
}

func sectionWireEqual(a, b Section) bool {
	if a.Y != b.Y || a.Blocks != b.Blocks || a.Blocks1 != b.Blocks1 ||
		a.SkyLight != b.SkyLight || a.BlockLight != b.BlockLight ||
		len(a.Palette) != len(b.Palette) {
		return false
	}
	for i := range a.Palette {
		if !blockEqual(a.Palette[i], b.Palette[i]) {
			return false
		}
	}
	return true
}

// columnLightOrBiomeChanged reports whether a re-encoded column carries new
// light or biome bytes that BlockChange deltas cannot express.
func columnLightOrBiomeChanged(prev, cur Column) bool {
	if prev.Biomes != cur.Biomes || len(prev.BiomePalette) != len(cur.BiomePalette) {
		return true
	}
	for i := range prev.BiomePalette {
		if prev.BiomePalette[i] != cur.BiomePalette[i] {
			return true
		}
	}
	prevByY := sectionsByY(prev)
	curByY := sectionsByY(cur)
	if len(prevByY) != len(curByY) {
		return true
	}
	for y, sec := range curByY {
		ps, ok := prevByY[y]
		if !ok || ps.SkyLight != sec.SkyLight || ps.BlockLight != sec.BlockLight {
			return true
		}
	}
	return false
}

// diffSectionBlocks expands one section pair into BlockChanges. missingPrev
// means the section is new; an empty cur means it vanished into air.
func diffSectionBlocks(pos [2]int32, prev, cur Section, hasPrev bool) []BlockChange {
	type key struct {
		sx, sy, sz, layer int
	}
	var prevCol, curCol Column
	if hasPrev {
		prevCol.Sections = []Section{prev}
	}
	if cur.Blocks != "" || cur.Blocks1 != "" || len(cur.Palette) > 0 {
		curCol.Sections = []Section{cur}
	}
	prevBlocks := sectionBlockMap(pos, prevCol)
	curBlocks := sectionBlockMap(pos, curCol)
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
	for k := range prevBlocks {
		if _, ok := seen[k]; ok {
			continue
		}
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

func (e *encoder) encodeColumn(w *gw.World, pos dfworld.ChunkPos, col *gw.Column, centerY int) Column {
	r := col.Range()
	out := Column{
		X:     pos[0],
		Z:     pos[1],
		State: col.State.String(),
		MinY:  r[0],
		MaxY:  r[1],
		// Never nil: a nil slice marshals as `null`, and a column with no
		// sections in range — a bot standing above the section window, say —
		// then arrived as `"sections": null` and threw in the consumer
		// ("sections is not iterable"), which froze the viewer for the rest of
		// the run. PROTOCOL.md promises arrays are present, possibly empty.
		Sections: []Section{},
	}
	// Unfilled light slices are stale zeros — sending them renders the column
	// black. Omit light instead; the viewer defaults omitted sky light to 15.
	lit := col.State == gw.ColumnComplete && col.LightFilled()
	subs := col.Sub()
	for i, sub := range subs {
		if sub == nil || sub.Empty() {
			continue
		}
		// PROTOCOL section y is the section index (covers y*16 .. y*16+15).
		secY := int(col.SubY(int16(i))) >> 4
		if absInt(secY-centerY) > e.sectionRadius {
			continue
		}
		sec, ok := e.encodeSection(w, sub, secY, lit)
		if ok {
			out.Sections = append(out.Sections, sec)
		}
	}
	if lit {
		out.BiomePalette, out.Biomes = encodeColumnBiomes(col)
	}
	out.BlockEntities = encodeColumnBlockEntities(col)
	return out
}

// encodeColumnBlockEntities projects dragonfly NBTer blocks into the wire list.
//
// @param col - World column.
// @returns block entities (nil when none).
func encodeColumnBlockEntities(col *gw.Column) []BlockEntity {
	if col == nil || len(col.BlockEntities) == 0 {
		return nil
	}
	out := make([]BlockEntity, 0, len(col.BlockEntities))
	for pos, bl := range col.BlockEntities {
		if bl == nil {
			continue
		}
		name, _ := bl.EncodeBlock()
		be := BlockEntity{
			Pos: [3]int{pos[0], pos[1], pos[2]},
			ID:  name,
		}
		if nbter, ok := bl.(dfworld.NBTer); ok {
			nbt := nbter.EncodeNBT()
			be.TextFront = signSideLines(nbt, "FrontText")
			be.TextBack = signSideLines(nbt, "BackText")
			if id, ok := nbt["id"].(string); ok && id != "" && be.ID == "" {
				be.ID = id
			}
		}
		if be.ID == "" {
			be.ID = "unknown"
		}
		out = append(out, be)
	}
	return out
}

// signSideLines extracts up to four lines from a sign-side NBT value.
func signSideLines(nbt map[string]any, key string) []string {
	if nbt == nil {
		return nil
	}
	raw, ok := nbt[key]
	if !ok {
		return nil
	}
	text := ""
	switch v := raw.(type) {
	case string:
		text = v
	case map[string]any:
		if t, ok := v["Text"].(string); ok {
			text = t
		}
	}
	if text == "" {
		return nil
	}
	var lines []string
	start := 0
	for i := 0; i <= len(text) && len(lines) < 4; i++ {
		if i == len(text) || text[i] == '\n' {
			lines = append(lines, text[start:i])
			start = i + 1
		}
	}
	return lines
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// encodeSection builds one wire Section. Returns ok=false for air-only.
//
// blocks is base64 of 4096 little-endian uint16 palette indices ordered
// index = (x << 8) | (z << 4) | y — Bedrock's own sub-chunk order, so the
// encoder is a straight triple loop with no swizzle.
//
// @param lit Whether sky/block light may be read (column complete + filled).
func (e *encoder) encodeSection(w *gw.World, sub *chunk.SubChunk, secY int, lit bool) (Section, bool) {
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
			sec, ok := e.encodeSectionUnified(w, sub, secY)
			if ok && lit {
				attachSectionLight(&sec, sub)
			}
			return sec, ok
		}
	}
	if lit {
		attachSectionLight(&sec, sub)
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
	// Dropped items store their stack on Item(), not HeldItems.
	if itemEnt, ok := ent.(interface{ Item() item.Stack }); ok {
		main = itemEnt.Item()
	}
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
		Swing:  st.Swing(),
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
			Type:         formTypeName(f.Type()),
			Title:        resolveLangLines(flattenRawtext(f.Title())),
			Content:      resolveLangLines(flattenRawtext(f.ContentText())),
			Buttons:      formButtons(f),
			ButtonImages: formButtonImages(f),
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
			buttons = append(buttons, resolveLangLines(flattenRawtext(b.Text())))
		}
		ui.Dialogue = &UIDialogue{
			NPCName: resolveLangLines(flattenRawtext(d.Title())),
			Text:    resolveLangLines(flattenRawtext(d.Text())),
			Buttons: buttons,
		}
	}
	for _, m := range a.RecentMessages(20) {
		if isProtocolChatNoise(m.Text) {
			continue
		}
		ui.Messages = append(ui.Messages, resolveLangLines(flattenRawtext(m.Text)))
	}
	st := a.ScreenTitle()
	ui.Title = resolveLangLines(filterHudControlText(flattenRawtext(st.Title)))
	ui.Subtitle = resolveLangLines(filterHudControlText(flattenRawtext(st.Subtitle)))
	ui.ActionBar = resolveLangLines(filterHudControlText(flattenRawtext(st.ActionBar)))
	// Omit default fade timings when nothing is on screen — keeps empty UI `{}`
	// on the wire instead of always shipping 10/70/20.
	if st.Title != "" || st.Subtitle != "" || st.ActionBar != "" {
		ui.FadeInTicks = st.FadeInTicks
		ui.StayTicks = st.StayTicks
		ui.FadeOutTicks = st.FadeOutTicks
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
			out[i] = resolveLangLines(flattenRawtext(b.Text()))
		}
		return out
	}
	if yes, no, ok := f.ModalFormButtons(); ok {
		return []string{
			resolveLangLines(flattenRawtext(yes.Text())),
			resolveLangLines(flattenRawtext(no.Text())),
		}
	}
	return nil
}

// formButtonImages lists each menu button's image (pack texture path or URL),
// parallel to formButtons.
//
// @param f The open form.
// @returns per-button image data, or nil when no button carries one.
func formButtonImages(f *actor.Form) []string {
	buttons, ok := f.MenuFormButtons()
	if !ok {
		return nil
	}
	out := make([]string, len(buttons))
	hasAny := false
	for i, b := range buttons {
		out[i] = b.Image().Data
		if out[i] != "" {
			hasAny = true
		}
	}
	if !hasAny {
		return nil
	}
	return out
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
	e := newEncoder("test", 4, 4)
	return e.encodeSection(w, sub, secY, false)
}

// attachSectionLight sets skyLight/blockLight on sec, omitting defaults
// (sky all 15, block all 0).
//
// @param sec Section to mutate.
// @param sub Source sub-chunk whose light slices were filled by LightArea.
func attachSectionLight(sec *Section, sub *chunk.SubChunk) {
	sky, block := packSectionLight(sub)
	if !isAllNibbles(sky, 15) {
		sec.SkyLight = base64.StdEncoding.EncodeToString(sky)
	}
	if !isAllNibbles(block, 0) {
		sec.BlockLight = base64.StdEncoding.EncodeToString(block)
	}
}

// packSectionLight reads 4096 sky and block light nibbles into 2048-byte
// arrays using index = (x << 8) | (z << 4) | y (same as blocks).
//
// @param sub Filled sub-chunk.
// @returns sky and block light byte slices.
func packSectionLight(sub *chunk.SubChunk) (sky, block []byte) {
	sky = make([]byte, 2048)
	block = make([]byte, 2048)
	for x := 0; x < 16; x++ {
		for z := 0; z < 16; z++ {
			for y := 0; y < 16; y++ {
				index := (uint16(x) << 8) | (uint16(z) << 4) | uint16(y)
				i := index >> 1
				bit := (index & 1) << 2
				sky[i] |= sub.SkyLight(byte(x), byte(y), byte(z)) << bit
				block[i] |= sub.BlockLight(byte(x), byte(y), byte(z)) << bit
			}
		}
	}
	return sky, block
}

// isAllNibbles reports whether every nibble in raw equals level.
//
// @param raw 2048-byte nibble array.
// @param level Expected 0–15 value.
// @returns true when every nibble matches.
func isAllNibbles(raw []byte, level uint8) bool {
	want := level | (level << 4)
	for _, b := range raw {
		if b != want {
			return false
		}
	}
	return true
}

// encodeColumnBiomes builds a 16×16 surface biome map for a column.
//
// For each (x,z), the biome is sampled at the top non-air block Y (or the
// column minimum when the column is empty air).
//
// @param col Source column.
// @returns biomePalette entries and base64 of 256 uint8 indices, or empty when
// the palette is unused.
func encodeColumnBiomes(col *gw.Column) (palette []any, biomesB64 string) {
	indexOf := map[uint32]uint8{}
	raw := make([]byte, 256)
	for x := uint8(0); x < 16; x++ {
		for z := uint8(0); z < 16; z++ {
			y := col.HighestBlock(x, z)
			id := col.Biome(x, y, z)
			idx, ok := indexOf[id]
			if !ok {
				if len(palette) >= 256 {
					idx = 0
				} else {
					idx = uint8(len(palette))
					indexOf[id] = idx
					palette = append(palette, biomePaletteEntry(id))
				}
			}
			raw[(int(x)<<4)|int(z)] = idx
		}
	}
	if len(palette) == 0 {
		return nil, ""
	}
	return palette, base64.StdEncoding.EncodeToString(raw)
}

// biomePaletteEntry maps a network biome id to a wire palette value.
//
// @param id Network biome id from the chunk biome storage.
// @returns dragonfly biome String() when registered, otherwise the numeric id.
func biomePaletteEntry(id uint32) any {
	if b, ok := dfworld.BiomeByID(int(id)); ok {
		return b.String()
	}
	return id
}

// encodeRegistries projects wire.Registries into the snapshot shape.
// Returns nil when registries were never enabled (viewer path unused).
func encodeRegistries(r *wire.Registries) *Registries {
	if r == nil {
		return nil
	}
	out := &Registries{
		Blocks: make([]RegistryBlock, 0, len(r.Blocks)),
		Items:  make([]RegistryItem, 0, len(r.Items)),
		Actors: make([]RegistryActor, 0, len(r.Actors)),
	}
	for _, def := range r.Blocks {
		out.Blocks = append(out.Blocks, encodeRegistryBlock(def))
	}
	for _, def := range r.Items {
		out.Items = append(out.Items, RegistryItem{
			Name:           def.Name,
			ComponentBased: def.ComponentBased,
			Version:        def.Version,
			Icon:           def.Icon,
			Components:     def.Components,
		})
	}
	for _, def := range r.Actors {
		actor := RegistryActor{Type: def.Type}
		for _, p := range def.Properties {
			actor.Properties = append(actor.Properties, RegistryActorProp{
				Name:    p.Name,
				Type:    p.Type,
				Default: p.Default,
				Min:     p.Min,
				Max:     p.Max,
				Enum:    p.Enum,
			})
		}
		out.Actors = append(out.Actors, actor)
	}
	return out
}

func encodeRegistryBlock(def wire.BlockDef) RegistryBlock {
	rb := RegistryBlock{
		Name:          def.Name,
		MolangVersion: def.MolangVersion,
		Components:    encodeRegistryComponents(def.Components),
	}
	for _, p := range def.Properties {
		rb.Properties = append(rb.Properties, RegistryProp{Name: p.Name, Enum: p.Enum})
	}
	for _, p := range def.Permutations {
		rb.Permutations = append(rb.Permutations, RegistryPerm{
			Condition:  p.Condition,
			Components: encodeRegistryComponents(p.Components),
		})
	}
	return rb
}

func encodeRegistryComponents(c wire.BlockComponents) RegistryComponents {
	out := RegistryComponents{
		Geometry:       c.Geometry,
		UnitCube:       c.UnitCube,
		BoneVisibility: c.BoneVisibility,
		LightEmission:  c.LightEmission,
	}
	if len(c.MaterialInstances) > 0 {
		out.MaterialInstances = make(map[string]RegistryMaterial, len(c.MaterialInstances))
		for face, m := range c.MaterialInstances {
			out.MaterialInstances[face] = RegistryMaterial{
				Texture:          m.Texture,
				RenderMethod:     m.RenderMethod,
				FaceDimming:      m.FaceDimming,
				AmbientOcclusion: m.AmbientOcclusion,
			}
		}
	}
	if c.Transformation != nil {
		t := c.Transformation
		out.Transformation = &RegistryTransform{
			RX: t.RX, RY: t.RY, RZ: t.RZ,
			SX: t.SX, SY: t.SY, SZ: t.SZ,
			TX: t.TX, TY: t.TY, TZ: t.TZ,
		}
	}
	if c.CollisionBox != nil {
		b := c.CollisionBox
		out.CollisionBox = &RegistryBox{
			Enabled: b.Enabled,
			MinX:    b.MinX, MinY: b.MinY, MinZ: b.MinZ,
			MaxX: b.MaxX, MaxY: b.MaxY, MaxZ: b.MaxZ,
		}
	}
	if c.SelectionBox != nil {
		b := c.SelectionBox
		out.SelectionBox = &RegistrySelectionBox{
			Enabled: b.Enabled,
			Origin:  b.Origin,
			Size:    b.Size,
		}
	}
	return out
}
