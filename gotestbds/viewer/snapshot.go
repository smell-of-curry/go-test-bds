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

// Keyframe carries everything the stream knows in one frame.
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
}

// Delta carries only keys that changed since the previous frame.
// Absent keys mean unchanged, never empty.
type Delta struct {
	V               int           `json:"v"`
	Type            string        `json:"type"`
	Bot             string        `json:"bot"`
	Tick            uint64        `json:"tick"`
	World           *World        `json:"world,omitempty"`
	Blocks          []BlockChange `json:"blocks,omitempty"`
	ColumnsAdded    []Column      `json:"columnsAdded,omitempty"`
	ColumnsRemoved  [][2]int32    `json:"columnsRemoved,omitempty"`
	ColumnsState    []ColumnState `json:"columnsState,omitempty"`
	EntitiesAdded   []Entity      `json:"entitiesAdded,omitempty"`
	EntitiesUpdated []Entity      `json:"entitiesUpdated,omitempty"`
	EntitiesRemoved []uint64      `json:"entitiesRemoved,omitempty"`
	Actor           *Actor        `json:"actor,omitempty"`
	UI              *UI           `json:"ui,omitempty"`
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
	V       int    `json:"v"`
	Type    string `json:"type"`
	Bot     string `json:"bot"`
	ID      string `json:"id"`
	MinTick uint64 `json:"minTick"`
	Ext     string `json:"ext"`
	Label   string `json:"label,omitempty"`
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

// UI is open forms/containers and recent chat.
type UI struct {
	Form      *UIForm      `json:"form,omitempty"`
	Container *UIContainer `json:"container,omitempty"`
	Sign      *UISign      `json:"sign,omitempty"`
	Dialogue  *UIDialogue  `json:"dialogue,omitempty"`
	Messages  []string     `json:"messages,omitempty"`
	Title     string       `json:"title,omitempty"`
	Subtitle  string       `json:"subtitle,omitempty"`
	ActionBar string       `json:"actionBar,omitempty"`
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
