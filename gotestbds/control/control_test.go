package control

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/instruction"
)

type echoInst struct {
	Message string `json:"message"`
}

func (*echoInst) Name() string                          { return "echo" }
func (e *echoInst) Run(context.Context, *bot.Bot) error { return nil }
func (e *echoInst) Data() any                           { return map[string]any{"message": e.Message} }

type blockInst struct{}

func (*blockInst) Name() string { return "block" }
func (*blockInst) Run(ctx context.Context, _ *bot.Bot) error {
	<-ctx.Done()
	return ctx.Err()
}

type stubConn struct{}

func (stubConn) IdentityData() login.IdentityData {
	return login.IdentityData{Identity: "00000000-0000-0000-0000-0000000000ab", DisplayName: "Dir"}
}
func (stubConn) GameData() minecraft.GameData {
	return minecraft.GameData{EntityRuntimeID: 1, EntityUniqueID: 1, ChunkRadius: 4}
}
func (stubConn) WritePacket(packet.Packet) error    { return nil }
func (stubConn) ReadPacket() (packet.Packet, error) { return nil, io.EOF }
func (stubConn) Close() error                       { return nil }

func TestControlDispatch(t *testing.T) {
	pull := instruction.NewPull()
	pull.Register(func() instruction.Instruction { return &echoInst{} })
	pull.Register(func() instruction.Instruction { return &blockInst{} })

	b := bot.NewBot(stubConn{}, nil)
	fleet := gotestbds.NewFleet()
	fleet.Add("Dir", b, pull, nil)

	srv := httptest.NewServer(New("secret", fleet, nil).Handler())
	defer srv.Close()

	if res, _ := http.Get(srv.URL + "/bots"); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no token: %d", res.StatusCode)
	}

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/bots", nil)
	req.Header.Set("Authorization", "secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("bots %d %s", res.StatusCode, body)
	}
	var listed struct {
		Bots []gotestbds.BotInfo `json:"bots"`
	}
	if err := json.Unmarshal(body, &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Bots) != 1 || listed.Bots[0].Name != "Dir" || !listed.Bots[0].Online {
		t.Fatalf("bots %+v", listed.Bots)
	}

	post := func(payload string) (int, map[string]any) {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, srv.URL+"/bots/Dir/instruction", strings.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "secret")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("status %d body %s", res.StatusCode, raw)
		}
		return res.StatusCode, m
	}

	code, m := post(`{"name":"echo","id":"req-1","message":"hi"}`)
	if code != 200 || m["status"] != gotestbds.StatusSuccess || m["id"] != "req-1" {
		t.Fatalf("echo %d %+v", code, m)
	}
	data, _ := m["data"].(map[string]any)
	if data["message"] != "hi" {
		t.Fatalf("data %+v", m["data"])
	}

	code, m = post(`{"name":"nope"}`)
	if code != 200 || m["status"] != gotestbds.StatusError {
		t.Fatalf("unknown %d %+v", code, m)
	}

	start := time.Now()
	code, m = post(`{"name":"block","timeoutMs":40}`)
	if code != 200 || m["status"] != gotestbds.StatusTimeOut {
		t.Fatalf("timeout %d %+v", code, m)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("timeout was not respected")
	}

	_ = b.Close()
	code, m = post(`{"name":"echo","message":"x"}`)
	if code != http.StatusConflict || m["status"] != gotestbds.StatusError {
		t.Fatalf("offline %d %+v", code, m)
	}

	req, _ = http.NewRequest(http.MethodGet, srv.URL+"/bots", nil)
	req.Header.Set("Authorization", "secret")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if err := json.Unmarshal(body, &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Bots) != 1 || listed.Bots[0].Online {
		t.Fatalf("after close %+v", listed.Bots)
	}
}
