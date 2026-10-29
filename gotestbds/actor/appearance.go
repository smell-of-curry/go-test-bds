package actor

import (
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/png"
	"strings"

	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
)

// skinIDPrefix marks a skin this process put on the login ClientData, so the
// local player entity can carry it without treating gophertunnel's default
// skin as a custom one.
const skinIDPrefix = "gotestbds:"

// Appearance is one player's skin, ready for the viewer snapshot and the
// PNG endpoint. RGBA is not retained; PNG is the encoded form of the wire bytes.
type Appearance struct {
	Hash     string
	Width    int
	Height   int
	Slim     bool
	Geometry string
	PNG      []byte
}

// HashSkin is the sha1 of little-endian width, little-endian height, then RGBA.
func HashSkin(width, height int, rgba []byte) string {
	h := sha1.New()
	var dim [8]byte
	binary.LittleEndian.PutUint32(dim[0:4], uint32(width))
	binary.LittleEndian.PutUint32(dim[4:8], uint32(height))
	_, _ = h.Write(dim[:])
	_, _ = h.Write(rgba)
	return hex.EncodeToString(h.Sum(nil))
}

// GeometryDefault reads geometry.default from a skin resource patch.
// An empty or unparsable patch returns "".
func GeometryDefault(patch []byte) string {
	patch = bytes.TrimSpace(patch)
	if len(patch) == 0 {
		return ""
	}
	var doc struct {
		Geometry struct {
			Default string `json:"default"`
		} `json:"geometry"`
	}
	if err := json.Unmarshal(patch, &doc); err != nil {
		return ""
	}
	return doc.Geometry.Default
}

// SlimSkin reports whether the skin should use the slim arm model.
// A geometry name containing "slim" wins. Otherwise geometry.humanoid.custom
// is wide, and an empty geometry falls back to the protocol arm size.
func SlimSkin(armSize uint8, geometry string) bool {
	g := strings.ToLower(geometry)
	if strings.Contains(g, "slim") {
		return true
	}
	if strings.Contains(g, "custom") {
		return false
	}
	return armSize == protocol.ArmSizeSlim
}

// NoteSkin stores a player-list or PlayerSkin update.
func (a *Actor) NoteSkin(id uuid.UUID, sk protocol.Skin) {
	w, h := int(sk.SkinImageWidth), int(sk.SkinImageHeight)
	if w <= 0 || h <= 0 || len(sk.SkinData) != w*h*4 {
		return
	}
	geom := GeometryDefault(sk.SkinResourcePatch)
	a.storeSkin(id, sk.SkinData, w, h, SlimSkin(sk.ArmSize, geom), geom)
}

// ForgetSkin drops a player-list removal.
func (a *Actor) ForgetSkin(id uuid.UUID) {
	delete(a.skins, id)
}

// Appearance returns the skin last stored for id.
func (a *Actor) Appearance(id uuid.UUID) (Appearance, bool) {
	if a == nil || a.skins == nil {
		return Appearance{}, false
	}
	ap, ok := a.skins[id]
	return ap, ok
}

func (a *Actor) storeSkin(id uuid.UUID, rgba []byte, w, h int, slim bool, geometry string) {
	pix := append([]byte(nil), rgba...)
	pngBytes, err := encodeRGBA(w, h, pix)
	if err != nil {
		return
	}
	if a.skins == nil {
		a.skins = make(map[uuid.UUID]Appearance)
	}
	a.skins[id] = Appearance{
		Hash:     HashSkin(w, h, pix),
		Width:    w,
		Height:   h,
		Slim:     slim,
		Geometry: geometry,
		PNG:      pngBytes,
	}
}

func encodeRGBA(w, h int, pix []byte) ([]byte, error) {
	img := &image.RGBA{
		Pix:    pix,
		Stride: w * 4,
		Rect:   image.Rect(0, 0, w, h),
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// noteLoginSkin copies a custom login skin onto the local player entity.
// Skins we did not apply (no gotestbds: SkinID) are ignored, so a default
// client still produces snapshots without a skin field.
func (a *Actor) noteLoginSkin() {
	type hasClientData interface {
		ClientData() login.ClientData
	}
	src, ok := a.conn.(hasClientData)
	if !ok {
		return
	}
	cd := src.ClientData()
	if !strings.HasPrefix(cd.SkinID, skinIDPrefix) {
		return
	}
	raw, err := base64.StdEncoding.DecodeString(cd.SkinData)
	if err != nil || cd.SkinImageWidth <= 0 || cd.SkinImageHeight <= 0 {
		return
	}
	if len(raw) != cd.SkinImageWidth*cd.SkinImageHeight*4 {
		return
	}
	id, err := uuid.Parse(a.conn.IdentityData().Identity)
	if err != nil {
		return
	}
	geom := ""
	if patch, err := base64.StdEncoding.DecodeString(cd.SkinResourcePatch); err == nil {
		geom = GeometryDefault(patch)
	}
	slim := cd.ArmSize == "slim" || strings.Contains(strings.ToLower(geom), "slim")
	a.storeSkin(id, raw, cd.SkinImageWidth, cd.SkinImageHeight, slim, geom)
}
