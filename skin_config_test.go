package main

import (
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
)

func TestBotSkinFlagsReachDistinctLoginData(t *testing.T) {
	dir := t.TempDir()
	makeSkin := func(name string, shade color.RGBA) string {
		t.Helper()
		path := filepath.Join(dir, name)
		im := image.NewRGBA(image.Rect(0, 0, 64, 64))
		for y := 0; y < 64; y++ {
			for x := 0; x < 64; x++ {
				im.SetRGBA(x, y, shade)
			}
		}
		f, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := png.Encode(f, im); err != nil {
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}
		return path
	}
	shared := makeSkin("shared.png", color.RGBA{R: 255, A: 255})
	opponent := makeSkin("opponent = blue.png", color.RGBA{B: 255, A: 255})
	old := os.Args
	t.Cleanup(func() { os.Args = old })
	os.Args = []string{"gotestbds", "--name", "Trainer", "--bots", "3", "--skin", shared, "--bot-skin", "Trainer2=" + opponent, "--bot-skin", "Trainer3=" + opponent}
	c := DefaultConfig()
	c.Skin.ByBot = map[string]string{"Trainer2": "replaced-by-flag.png"}
	if err := applyFlags(&c); err != nil {
		t.Fatal(err)
	}
	var first, second, third login.ClientData
	for i, data := range []*login.ClientData{&first, &second, &third} {
		if err := applyBotSkin(data, c, c.BotName(i)); err != nil {
			t.Fatal(err)
		}
	}
	if first.SkinData == second.SkinData || first.SkinID == second.SkinID {
		t.Fatal("distinct trainers received the same skin")
	}
	if second.SkinData != third.SkinData || second.PlayFabID == third.PlayFabID {
		t.Fatal("shared override changed skin bytes or merged client identities")
	}
	if c.SkinPath("trainer2") != shared {
		t.Fatal("override must match the exact display name")
	}
	if first.SkinImageWidth != 64 || second.ArmSize != "wide" {
		t.Fatal("incorrect login skin metadata")
	}
	delete(c.Skin.ByBot, "Trainer3")
	c.Skin.Path = ""
	var untouched login.ClientData
	if err := applyBotSkin(&untouched, c, "Trainer3"); err != nil || untouched.SkinData != "" {
		t.Fatal("no configured skin must preserve client defaults")
	}
	c.Skin.ByBot["Trainer3"] = filepath.Join(dir, "missing.png")
	if err := applyBotSkin(&untouched, c, "Trainer3"); err == nil {
		t.Fatal("missing per-bot skin must fail rather than silently use the shared skin")
	}
}

func TestBotSkinFlagRejectsIncompleteAssignment(t *testing.T) {
	for _, value := range []string{"missing-separator", "=path.png", "Trainer=", " =path.png"} {
		var overrides skinOverrides
		if err := overrides.Set(value); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
}
