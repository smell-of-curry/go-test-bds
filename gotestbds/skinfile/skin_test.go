package skinfile

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
)

func TestApplySkin(t *testing.T) {
	path := writePNG(t, 64, 64, []byte{1, 2, 3, 255})
	var cd login.ClientData
	if err := Apply(&cd, path, true, "Cam"); err != nil {
		t.Fatal(err)
	}
	if cd.SkinImageWidth != 64 || cd.SkinImageHeight != 64 {
		t.Fatalf("size %dx%d", cd.SkinImageWidth, cd.SkinImageHeight)
	}
	if cd.ArmSize != "slim" {
		t.Fatalf("arm %q", cd.ArmSize)
	}
	if cd.PersonaSkin || cd.PremiumSkin {
		t.Fatal("persona/premium should be false")
	}
	if cd.CapeData != "" || len(cd.AnimatedImageData) != 0 || len(cd.PersonaPieces) != 0 {
		t.Fatal("expected empty cape, animations and persona")
	}
	if !strings.HasPrefix(cd.SkinID, "gotestbds:") {
		t.Fatalf("skin id %q", cd.SkinID)
	}
	if len(cd.PlayFabID) != 16 {
		t.Fatalf("playfab %q", cd.PlayFabID)
	}
	again := login.ClientData{}
	if err := Apply(&again, path, true, "Cam"); err != nil {
		t.Fatal(err)
	}
	if again.PlayFabID != cd.PlayFabID || again.SkinID != cd.SkinID {
		t.Fatal("skin id and playfab should be stable for the same pixels and name")
	}
	other := login.ClientData{}
	if err := Apply(&other, path, false, "Other"); err != nil {
		t.Fatal(err)
	}
	if other.PlayFabID == cd.PlayFabID {
		t.Fatal("playfab should depend on the bot name")
	}
	if other.ArmSize != "wide" {
		t.Fatalf("arm %q", other.ArmSize)
	}
	patch, err := base64.StdEncoding.DecodeString(other.SkinResourcePatch)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(patch), "geometry.humanoid.custom") || strings.Contains(string(patch), "Slim") {
		t.Fatalf("patch %s", patch)
	}
	raw, err := base64.StdEncoding.DecodeString(cd.SkinData)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != 64*64*4 || raw[0] != 1 || raw[3] != 255 {
		t.Fatalf("rgba len %d first %v", len(raw), raw[:4])
	}
}

func TestDecodeRejectsBadSize(t *testing.T) {
	path := writePNG(t, 32, 32, []byte{0, 0, 0, 255})
	if _, _, _, err := Decode(path); err == nil {
		t.Fatal("expected size error")
	}
}

func writePNG(t *testing.T, w, h int, px []byte) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		copy(img.Pix[i:i+4], px)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "skin.png")
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}
