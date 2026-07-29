package viewer

// Schema version carried on every frame. Bump on any change an older client
// could misread.
const SchemaVersion = 1

// TickRate is the Bedrock server tick rate the stream advertises.
const TickRate = 20

// Hello is the first frame on every SSE connection.
type Hello struct {
	V        int    `json:"v"`
	Type     string `json:"type"`
	Bot      string `json:"bot"`
	Schema   int    `json:"schema"`
	TickRate int    `json:"tickRate"`
	Radius   int    `json:"radius"`
}

// Keyframe carries world metadata, actor, entities, UI, registries, and a
// budgeted subset of columns. Remaining columns arrive on later deltas as
// columnsAdded; columnsPending counts how many are still outstanding.
type Keyframe struct {
	V        int      `json:"v"`
	Type     string   `json:"type"`
	Bot      string   `json:"bot"`
	Tick     uint64   `json:"tick"`
	World    World    `json:"world"`
	Actor    Actor    `json:"actor"`
	Columns  []Column `json:"columns"`
	Entities []Entity `json:"entities"`
	UI       UI       `json:"ui"`
	// ColumnsPending is how many columns in the stream radius have not yet
	// been delivered to this subscriber. Zero/absent means the world is
	// fully delivered; non-zero means more columnsAdded frames follow.
	ColumnsPending int `json:"columnsPending,omitempty"`
	// Registries is join-static wire content (custom blocks, items, entity
	// property defs). Present on every keyframe (including after hello); omitted
	// on deltas because it does not change during a run.
	Registries *Registries `json:"registries,omitempty"`
}

// Delta carries only keys that changed since the previous frame.
// Absent keys mean unchanged, never empty.
type Delta struct {
	V              int           `json:"v"`
	Type           string        `json:"type"`
	Bot            string        `json:"bot"`
	Tick           uint64        `json:"tick"`
	World          *World        `json:"world,omitempty"`
	Blocks         []BlockChange `json:"blocks,omitempty"`
	ColumnsAdded   []Column      `json:"columnsAdded,omitempty"`
	ColumnsRemoved [][2]int32    `json:"columnsRemoved,omitempty"`
	ColumnsState   []ColumnState `json:"columnsState,omitempty"`
	// ColumnsPending is how many columns in the stream radius this subscriber
	// has not yet received. Present while catch-up is in progress.
	ColumnsPending  int      `json:"columnsPending,omitempty"`
	EntitiesAdded   []Entity `json:"entitiesAdded,omitempty"`
	EntitiesUpdated []Entity `json:"entitiesUpdated,omitempty"`
	EntitiesRemoved []uint64 `json:"entitiesRemoved,omitempty"`
	Actor           *Actor   `json:"actor,omitempty"`
	UI              *UI      `json:"ui,omitempty"`
}

// Mark is a run-lifecycle event broadcast to every bot stream.
type Mark struct {
	Phase     string `json:"phase"`
	RunID     string `json:"runId,omitempty"`
	Suite     string `json:"suite,omitempty"`
	Test      string `json:"test,omitempty"`
	Status    string `json:"status,omitempty"`
	Message   string `json:"message,omitempty"`
	ElapsedMs int64  `json:"elapsedMs,omitempty"`
}

// markFrame is the on-wire mark envelope.
type markFrame struct {
	V         int    `json:"v"`
	Type      string `json:"type"`
	Bot       string `json:"bot"`
	Tick      uint64 `json:"tick"`
	Phase     string `json:"phase"`
	RunID     string `json:"runId,omitempty"`
	Suite     string `json:"suite,omitempty"`
	Test      string `json:"test,omitempty"`
	Status    string `json:"status,omitempty"`
	Message   string `json:"message,omitempty"`
	ElapsedMs int64  `json:"elapsedMs,omitempty"`
}

// Capture is a request for a still from the harness.
type CaptureFrame struct {
	V    int    `json:"v"`
	Type string `json:"type"`
	Bot  string `json:"bot"`
	ID   string `json:"id"`
	// MinTick is the earliest tick a frame may be rendered from.
	MinTick uint64 `json:"minTick"`
	// TimeoutMs is the caller's deadline, carried so the harness gives up at the
	// same moment this side does instead of capping it with its own constant.
	TimeoutMs int64  `json:"timeoutMs,omitempty"`
	Ext       string `json:"ext"`
	Label     string `json:"label,omitempty"`
}

// World is dimension metadata for a snapshot.
type World struct {
	Dimension     int32  `json:"dimension"`
	DimensionName string `json:"dimensionName"`
	MinY          int    `json:"minY"`
	MaxY          int    `json:"maxY"`
}

// Block is an identifier plus state properties and the raw network runtime ID.
type Block struct {
	Name   string         `json:"name"`
	States map[string]any `json:"states"`
	RID    uint32         `json:"rid"`
}

// Registries is the projection of join-sequence definitions (schema "registry"
// content). Delivered as keyframe.registries after hello — see PROTOCOL.md.
type Registries struct {
	Blocks []RegistryBlock `json:"blocks"`
	Items  []RegistryItem  `json:"items"`
	Actors []RegistryActor `json:"actors"`
}

// RegistryBlock is one custom block from GameData.CustomBlocks.
type RegistryBlock struct {
	Name          string             `json:"name"`
	MolangVersion int32              `json:"molangVersion,omitempty"`
	Properties    []RegistryProp     `json:"properties,omitempty"`
	Components    RegistryComponents `json:"components"`
	Permutations  []RegistryPerm     `json:"permutations,omitempty"`
}

// RegistryProp is a block state property declaration.
type RegistryProp struct {
	Name string `json:"name"`
	Enum []any  `json:"enum,omitempty"`
}

// RegistryPerm is a permutation condition + component overrides.
type RegistryPerm struct {
	Condition  string             `json:"condition"`
	Components RegistryComponents `json:"components"`
}

// RegistryComponents are render-relevant block components.
type RegistryComponents struct {
	Geometry          string                      `json:"geometry,omitempty"`
	UnitCube          bool                        `json:"unitCube,omitempty"`
	MaterialInstances map[string]RegistryMaterial `json:"materialInstances,omitempty"`
	Transformation    *RegistryTransform          `json:"transformation,omitempty"`
	LightEmission     *float32                    `json:"lightEmission,omitempty"`
	CollisionBox      *RegistryBox                `json:"collisionBox,omitempty"`
	SelectionBox      *RegistrySelectionBox       `json:"selectionBox,omitempty"`
	BoneVisibility    map[string]any              `json:"boneVisibility,omitempty"`
}

// RegistryMaterial is one material_instances face entry.
type RegistryMaterial struct {
	Texture          string `json:"texture,omitempty"`
	RenderMethod     string `json:"renderMethod,omitempty"`
	FaceDimming      bool   `json:"faceDimming,omitempty"`
	AmbientOcclusion bool   `json:"ambientOcclusion,omitempty"`
}

// RegistryTransform is minecraft:transformation.
type RegistryTransform struct {
	RX int32   `json:"rx"`
	RY int32   `json:"ry"`
	RZ int32   `json:"rz"`
	SX float32 `json:"sx"`
	SY float32 `json:"sy"`
	SZ float32 `json:"sz"`
	TX float32 `json:"tx"`
	TY float32 `json:"ty"`
	TZ float32 `json:"tz"`
}

// RegistryBox is a collision box in pixels.
type RegistryBox struct {
	Enabled bool    `json:"enabled"`
	MinX    float32 `json:"minX"`
	MinY    float32 `json:"minY"`
	MinZ    float32 `json:"minZ"`
	MaxX    float32 `json:"maxX"`
	MaxY    float32 `json:"maxY"`
	MaxZ    float32 `json:"maxZ"`
}

// RegistrySelectionBox is origin+size selection box in pixels.
type RegistrySelectionBox struct {
	Enabled bool       `json:"enabled"`
	Origin  [3]float32 `json:"origin"`
	Size    [3]float32 `json:"size"`
}

// RegistryItem is one component-based item from ItemRegistry.
type RegistryItem struct {
	Name           string         `json:"name"`
	ComponentBased bool           `json:"componentBased"`
	Version        int32          `json:"version,omitempty"`
	Icon           string         `json:"icon,omitempty"`
	Components     map[string]any `json:"components,omitempty"`
}

// RegistryActor is entity property definitions for one type (SyncActorProperty).
type RegistryActor struct {
	Type       string              `json:"type"`
	Properties []RegistryActorProp `json:"properties"`
}

// RegistryActorProp is a typed entity property for query.property.
type RegistryActorProp struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	Default any      `json:"default,omitempty"`
	Min     *float64 `json:"min,omitempty"`
	Max     *float64 `json:"max,omitempty"`
	Enum    []string `json:"enum,omitempty"`
}

// BlockChange is a single-block update in a delta.
type BlockChange struct {
	Pos   [3]int `json:"pos"`
	Layer int    `json:"layer"`
	Block Block  `json:"block"`
}

// Column is a chunk column within the stream radius.
type Column struct {
	X        int32     `json:"x"`
	Z        int32     `json:"z"`
	State    string    `json:"state"`
	MinY     int       `json:"minY"`
	MaxY     int       `json:"maxY"`
	Sections []Section `json:"sections"`
	// BiomePalette lists biome ids referenced by Biomes. Entries are dragonfly
	// biome String() names when known, otherwise the numeric network id.
	BiomePalette []any `json:"biomePalette,omitempty"`
	// Biomes is base64 of 256 uint8 palette indices, one per column (x,z) at the
	// surface (top non-air). Index order is (x << 4) | z. Absent when unknown.
	Biomes string `json:"biomes,omitempty"`
	// BlockEntities carries NBT-backed tile entities the client draws with
	// dedicated geometry (chests, signs, …). Additive field — omitted when empty.
	BlockEntities []BlockEntity `json:"blockEntities,omitempty"`
}

// BlockEntity is a minimal projection of a column tile entity for the viewer.
type BlockEntity struct {
	Pos       [3]int   `json:"pos"`
	ID        string   `json:"id"`
	TextFront []string `json:"textFront,omitempty"`
	TextBack  []string `json:"textBack,omitempty"`
}

// ColumnState reports a column's load-progress change without resending blocks.
type ColumnState struct {
	X     int32  `json:"x"`
	Z     int32  `json:"z"`
	State string `json:"state"`
}

// Section is one 16³ sub-chunk. Air-only sections are omitted.
type Section struct {
	Y       int     `json:"y"`
	Palette []Block `json:"palette"`
	Blocks  string  `json:"blocks"`
	Blocks1 string  `json:"blocks1,omitempty"`
	// SkyLight is base64 of 2048 bytes (4096 nibbles) in the same index order as
	// blocks: index = (x << 8) | (z << 4) | y. Absent means all 15.
	SkyLight string `json:"skyLight,omitempty"`
	// BlockLight is base64 of 2048 bytes in the same nibble order as SkyLight.
	// Absent means all 0.
	BlockLight string `json:"blockLight,omitempty"`
}

// Entity is a tracked world entity.
type Entity struct {
	RID        uint64             `json:"rid"`
	UID        int64              `json:"uid"`
	Type       string             `json:"type"`
	Pos        [3]float64         `json:"pos"`
	Rot        []float64          `json:"rot"`
	Vel        [3]float64         `json:"vel"`
	BBox       [2]float64         `json:"bbox"`
	Name       string             `json:"name,omitempty"`
	Player     bool               `json:"player"`
	Flags      map[string]bool    `json:"flags"`
	Props      map[string]any     `json:"props"`
	Attributes map[string]float64 `json:"attributes"`
	Held       HeldItems          `json:"held"`
	Armour     []*Item            `json:"armour"`
}

// HeldItems is main- and off-hand.
type HeldItems struct {
	Main *Item `json:"main"`
	Off  *Item `json:"off"`
}

// Item is a stack on the wire.
type Item struct {
	Name       string `json:"name"`
	Count      int    `json:"count"`
	Damage     int    `json:"damage,omitempty"`
	CustomName string `json:"customName,omitempty"`
}

// Actor is the observed bot.
type Actor struct {
	RID         uint64     `json:"rid"`
	UID         int64      `json:"uid"`
	Name        string     `json:"name"`
	Pos         [3]float64 `json:"pos"`
	EyePos      [3]float64 `json:"eyePos"`
	Rot         []float64  `json:"rot"`
	Vel         [3]float64 `json:"vel"`
	OnGround    bool       `json:"onGround"`
	Gamemode    int        `json:"gamemode"`
	Dimension   int32      `json:"dimension"`
	Health      float64    `json:"health"`
	MaxHealth   float64    `json:"maxHealth"`
	Food        float64    `json:"food"`
	HeldSlot    int        `json:"heldSlot"`
	Sneaking    bool       `json:"sneaking"`
	Sprinting   bool       `json:"sprinting"`
	Swimming    bool       `json:"swimming"`
	Gliding     bool       `json:"gliding"`
	Hotbar      []*Item    `json:"hotbar"`
	Inventory   []*Item    `json:"inventory"`
	Offhand     *Item      `json:"offhand"`
	Armour      []*Item    `json:"armour"`
	Effects     []Effect   `json:"effects"`
	ChunkRadius int        `json:"chunkRadius"`
	LookingAt   *LookingAt `json:"lookingAt,omitempty"`
}

// LookingAt is the block under the crosshair.
type LookingAt struct {
	Pos   [3]int `json:"pos"`
	Face  string `json:"face"`
	Block Block  `json:"block"`
}

// Effect is a status effect on the actor.
type Effect struct {
	Name       string `json:"name"`
	Level      int    `json:"level"`
	DurationMs int64  `json:"durationMs"`
}

// UI is open forms/containers and recent chat / title state.
type UI struct {
	Form      *UIForm      `json:"form,omitempty"`
	Container *UIContainer `json:"container,omitempty"`
	Sign      *UISign      `json:"sign,omitempty"`
	Dialogue  *UIDialogue  `json:"dialogue,omitempty"`
	Messages  []string     `json:"messages,omitempty"`
	Title     string       `json:"title,omitempty"`
	Subtitle  string       `json:"subtitle,omitempty"`
	ActionBar string       `json:"actionBar,omitempty"`
	// Fade timings for title/subtitle (ticks). Absent → client defaults.
	FadeInTicks  int32 `json:"fadeInTicks,omitempty"`
	StayTicks    int32 `json:"stayTicks,omitempty"`
	FadeOutTicks int32 `json:"fadeOutTicks,omitempty"`
}

// ChatFrame is one player-facing chat/system line on the event lane.
// Protocol noise ([RUN_ACTION]/[STATUS]/[GOTESTBDS]) is never emitted.
type ChatFrame struct {
	V    int    `json:"v"`
	Type string `json:"type"`
	Bot  string `json:"bot"`
	Tick uint64 `json:"tick"`
	Text string `json:"text"`
}

// TitleFrame is a title / subtitle / action-bar update on the event lane.
type TitleFrame struct {
	V            int    `json:"v"`
	Type         string `json:"type"`
	Bot          string `json:"bot"`
	Tick         uint64 `json:"tick"`
	Title        string `json:"title,omitempty"`
	Subtitle     string `json:"subtitle,omitempty"`
	ActionBar    string `json:"actionBar,omitempty"`
	FadeInTicks  int32  `json:"fadeInTicks,omitempty"`
	StayTicks    int32  `json:"stayTicks,omitempty"`
	FadeOutTicks int32  `json:"fadeOutTicks,omitempty"`
	// Clear is true when the packet cleared/reset the title surfaces.
	Clear bool `json:"clear,omitempty"`
}

// UIForm is an open server form.
type UIForm struct {
	Type    string   `json:"type"`
	Title   string   `json:"title"`
	Content string   `json:"content"`
	Buttons []string `json:"buttons,omitempty"`
}

// UIContainer is an open block/entity inventory.
type UIContainer struct {
	Type  string  `json:"type"`
	Title string  `json:"title,omitempty"`
	Slots []*Item `json:"slots"`
}

// UISign is an open sign editor.
type UISign struct {
	Front []string `json:"front"`
	Back  []string `json:"back"`
}

// UIDialogue is an open NPC dialogue.
type UIDialogue struct {
	NPCName string   `json:"npcName"`
	Text    string   `json:"text"`
	Buttons []string `json:"buttons,omitempty"`
}

// Artifact is a captured screenshot or video segment.
type Artifact struct {
	Path       string `json:"path"`
	Bytes      int    `json:"bytes"`
	Kind       string `json:"kind,omitempty"`
	Ext        string `json:"ext,omitempty"`
	Bot        string `json:"bot,omitempty"`
	Tick       uint64 `json:"tick,omitempty"`
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
	DurationMs int64  `json:"durationMs,omitempty"`
	RunID      string `json:"runId,omitempty"`
	Suite      string `json:"suite,omitempty"`
	Test       string `json:"test,omitempty"`
	Label      string `json:"label,omitempty"`
}

// BotInfo is one entry in GET /bots and /health.
type BotInfo struct {
	Name      string `json:"name"`
	Tick      uint64 `json:"tick"`
	Dimension int32  `json:"dimension"`
	Attached  int    `json:"attached"`
}
