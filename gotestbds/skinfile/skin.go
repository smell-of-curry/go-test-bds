// Package skinfile loads a PNG into a login ClientData skin.
// Decoding happens here, once, for the bot's own login — the viewer does not
// decode pack images.
package skinfile

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"os"

	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
)

// Apply reads path and fills the skin fields on cd.
//
// Accepted sizes are 64×32, 64×64 and 128×128. slim selects
// geometry.humanoid.customSlim and ArmSize "slim"; otherwise the skin is wide.
// stableKey (the bot name) derives a stable PlayFabID. SkinID is
// "gotestbds:" plus the sha1 of the RGBA bytes so the actor can recognise a
// skin this process applied.
//
// Capes, animations and persona pieces are left empty. SkinGeometry is left
// empty so gophertunnel can fill the default humanoid geometry at dial time.
func Apply(cd *login.ClientData, path string, slim bool, stableKey string) error {
	rgba, w, h, err := Decode(path)
	if err != nil {
		return err
	}
	geom := "geometry.humanoid.custom"
	arm := "wide"
	if slim {
		geom = "geometry.humanoid.customSlim"
		arm = "slim"
	}
	patch := []byte(fmt.Sprintf(`{"geometry":{"default":"%s"}}`, geom))
	sum := sha1.Sum(rgba)
	cd.SkinData = base64.StdEncoding.EncodeToString(rgba)
	cd.SkinImageWidth = w
	cd.SkinImageHeight = h
	cd.SkinResourcePatch = base64.StdEncoding.EncodeToString(patch)
	cd.ArmSize = arm
	cd.SkinID = "gotestbds:" + hex.EncodeToString(sum[:])
	cd.PlayFabID = playFabID(stableKey)
	cd.PersonaSkin = false
	cd.PremiumSkin = false
	cd.CapeData = ""
	cd.CapeID = ""
	cd.CapeImageWidth = 0
	cd.CapeImageHeight = 0
	cd.CapeOnClassicSkin = false
	cd.SkinAnimationData = ""
	cd.AnimatedImageData = []login.SkinAnimation{}
	cd.PersonaPieces = []login.PersonaPiece{}
	cd.PieceTintColours = []login.PersonaPieceTintColour{}
	return nil
}

// Decode reads a skin PNG and returns tightly packed RGBA.
func Decode(path string) (rgba []byte, width, height int, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, 0, err
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("skin: %s: %w", path, err)
	}
	b := img.Bounds()
	width, height = b.Dx(), b.Dy()
	switch {
	case width == 64 && (height == 32 || height == 64):
	case width == 128 && height == 128:
	default:
		return nil, 0, 0, fmt.Errorf("skin: want 64x32, 64x64, or 128x128, got %dx%d", width, height)
	}
	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(dst, dst.Bounds(), img, b.Min, draw.Src)
	return dst.Pix, width, height, nil
}

func playFabID(key string) string {
	sum := sha1.Sum([]byte("gotestbds-playfab:" + key))
	return hex.EncodeToString(sum[:8])
}
