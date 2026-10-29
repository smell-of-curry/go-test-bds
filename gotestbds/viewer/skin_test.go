package viewer

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
)

func TestSkinHashAndEndpoint(t *testing.T) {
	rgba := bytes.Repeat([]byte{9, 8, 7, 255}, 64*32)
	h1 := actor.HashSkin(64, 32, rgba)
	if h1 != actor.HashSkin(64, 32, rgba) || len(h1) != 40 {
		t.Fatalf("hash %s", h1)
	}
	if actor.HashSkin(64, 64, rgba) == h1 {
		t.Fatal("dimensions must be part of the hash")
	}

	hub, err := New(Options{Address: "127.0.0.1:0", ArtifactDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	geom := "geometry.humanoid.custom"
	a := testActor(t, "Cam")
	own := uuid.MustParse("00000000-0000-0000-0000-000000000001")
	a.NoteSkin(own, protocol.Skin{
		SkinImageWidth:    64,
		SkinImageHeight:   32,
		SkinData:          rgba,
		SkinResourcePatch: []byte(`{"geometry":{"default":"geometry.humanoid.custom"}}`),
		ArmSize:           protocol.ArmSizeWide,
	})
	ap, ok := a.Appearance(own)
	if !ok {
		t.Fatal("missing appearance")
	}
	hub.PutSkin(ap.Hash, ap.PNG)

	res, err := http.Get("http://" + hub.Addr() + "/skin/" + ap.Hash + ".png")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content-type %q", ct)
	}
	img, err := png.Decode(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != 64 || img.Bounds().Dy() != 32 {
		t.Fatalf("png %v", img.Bounds())
	}
	got := image.NewRGBA(img.Bounds())
	for y := 0; y < 32; y++ {
		for x := 0; x < 64; x++ {
			got.Set(x, y, img.At(x, y))
		}
	}
	if !bytes.Equal(got.Pix, rgba) {
		t.Fatal("png pixels differ from wire rgba")
	}
	if ap.Geometry != geom || ap.Slim {
		t.Fatalf("geom %q slim %v", ap.Geometry, ap.Slim)
	}

	missing, err := http.Get("http://" + hub.Addr() + "/skin/deadbeef.png")
	if err != nil {
		t.Fatal(err)
	}
	missing.Body.Close()
	if missing.StatusCode != http.StatusNotFound {
		t.Fatalf("missing status %d", missing.StatusCode)
	}
}

func TestPlayerListSkinAndEmote(t *testing.T) {
	a := testActor(t, "Cam")
	other := uuid.MustParse("22222222-2222-2222-2222-222222222222")
	rgba := bytes.Repeat([]byte{1, 2, 3, 255}, 64*64)
	if err := (&bot.PlayerListHandler{}).Handle(&packet.PlayerList{Entries: []protocol.PlayerListEntry{{
		ActionType: protocol.PlayerListActionAdd,
		UUID:       other,
		Username:   "Extra",
		Skin: protocol.Skin{
			SkinImageWidth:    64,
			SkinImageHeight:   64,
			SkinData:          rgba,
			SkinResourcePatch: []byte(`{"geometry":{"default":"geometry.humanoid.customSlim"}}`),
			ArmSize:           protocol.ArmSizeSlim,
		},
	}}}, nil, a); err != nil {
		t.Fatal(err)
	}
	ent := entity.CreateFromPacket(&packet.AddPlayer{
		UUID:            other,
		Username:        "Extra",
		EntityRuntimeID: 9,
		AbilityData:     protocol.AbilityData{EntityUniqueID: 9},
	})
	a.World().AddEntity(ent)
	if err := (&bot.EmoteHandler{}).Handle(&packet.Emote{
		EntityRuntimeID: 9,
		EmoteID:         "4c8ae710-df2e-47cd-814d-cc7bf21a3d67",
	}, nil, a); err != nil {
		t.Fatal(err)
	}

	hub, err := New(Options{Address: "127.0.0.1:0", ArtifactDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	enc := newEncoder("Cam", 4, 4)
	enc.noteSkin = hub.PutSkin
	event, payload, err := enc.frame(a)
	if err != nil {
		t.Fatal(err)
	}
	if event != "keyframe" {
		t.Fatalf("event %s", event)
	}
	var kf struct {
		Entities []struct {
			RID   uint64       `json:"rid"`
			Skin  *EntitySkin  `json:"skin"`
			Emote *EntityEmote `json:"emote"`
		} `json:"entities"`
	}
	if err := json.Unmarshal(payload, &kf); err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, e := range kf.Entities {
		if e.RID != 9 {
			continue
		}
		found = true
		if e.Skin == nil || e.Emote == nil {
			t.Fatalf("entity %+v", e)
		}
		if !e.Skin.Slim || e.Skin.Geometry != "geometry.humanoid.customSlim" {
			t.Fatalf("skin %+v", e.Skin)
		}
		if e.Skin.Width != 64 || e.Skin.Height != 64 {
			t.Fatalf("size %+v", e.Skin)
		}
		if e.Skin.Hash != actor.HashSkin(64, 64, rgba) {
			t.Fatalf("hash %s", e.Skin.Hash)
		}
		if e.Skin.URL != "/skin/"+e.Skin.Hash+".png" {
			t.Fatalf("url %s", e.Skin.URL)
		}
		if e.Emote.ID != "4c8ae710-df2e-47cd-814d-cc7bf21a3d67" {
			t.Fatalf("emote %+v", e.Emote)
		}
		res, err := http.Get("http://" + hub.Addr() + e.Skin.URL)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("skin url %d", res.StatusCode)
		}
	}
	if !found {
		t.Fatal("player entity missing from keyframe")
	}

	// A PlayerSkin update replaces the stored texture.
	rgba[0] = 9
	if err := (&bot.PlayerSkinHandler{}).Handle(&packet.PlayerSkin{
		UUID: other,
		Skin: protocol.Skin{
			SkinImageWidth:  64,
			SkinImageHeight: 64,
			SkinData:        rgba,
			ArmSize:         protocol.ArmSizeWide,
		},
	}, nil, a); err != nil {
		t.Fatal(err)
	}
	ap, ok := a.Appearance(other)
	if !ok || ap.Hash == actor.HashSkin(64, 64, bytes.Repeat([]byte{1, 2, 3, 255}, 64*64)) {
		t.Fatal("player skin did not replace the texture")
	}

	if err := (&bot.PlayerListHandler{}).Handle(&packet.PlayerList{Entries: []protocol.PlayerListEntry{{
		ActionType: protocol.PlayerListActionRemove,
		UUID:       other,
	}}}, nil, a); err != nil {
		t.Fatal(err)
	}
	if _, ok := a.Appearance(other); ok {
		t.Fatal("skin survived player list removal")
	}
}
