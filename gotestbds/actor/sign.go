package actor

import (
	"fmt"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// NewSign ...
func NewSign(bl world.NBTer, pos cube.Pos, isFrontSide bool, conn Conn) *Sign {
	return &Sign{bl: bl, pos: pos, isFrontSide: isFrontSide, conn: conn}
}

// Sign represents all editable objects.
type Sign struct {
	bl          world.NBTer
	pos         cube.Pos
	isFrontSide bool
	edited      bool
	conn        Conn
}

// Edit sends changes to the server.
func (s *Sign) Edit(text string) error {
	if s.edited {
		return fmt.Errorf("sign has already been edited")
	}
	s.edited = true

	textData := map[string]any{"Text": text}
	nbt := s.bl.EncodeNBT()
	if nbt == nil {
		nbt = make(map[string]any)
	}

	if s.isFrontSide {
		nbt["FrontText"] = textData
	} else {
		nbt["BackText"] = textData
	}

	return s.conn.WritePacket(&packet.BlockActorData{
		Position: posToProtocol(s.pos),
		NBTData:  nbt,
	})
}

// Pos returns position of the object.
func (s *Sign) Pos() cube.Pos {
	return s.pos
}

// Front returns whether the editable side is front.
func (s *Sign) Front() bool {
	return s.isFrontSide
}

// Object returns editable object.
func (s *Sign) Object() world.NBTer {
	return s.bl
}

// Lines returns the front and back text lines stored on the sign block.
//
// Bedrock packs sign text into FrontText/BackText NBT; the viewer only needs
// the rendered lines, so this unwraps that without exposing the raw map.
//
// @returns front and back lines (may be empty slices).
func (s *Sign) Lines() (front, back []string) {
	if s.bl == nil {
		return nil, nil
	}
	nbt := s.bl.EncodeNBT()
	return signSideLines(nbt, "FrontText"), signSideLines(nbt, "BackText")
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
	parts := splitSignLines(text)
	return parts
}

// splitSignLines splits Bedrock sign text on newlines, capping at four lines.
func splitSignLines(text string) []string {
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
