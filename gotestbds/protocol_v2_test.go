package gotestbds

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/smell-of-curry/go-test-bds/gotestbds/instruction"
)

func TestDecodeActionEnvelope(t *testing.T) {
	pull := instruction.DefaultPull(nil)

	t.Run("legacy without id/timeout", func(t *testing.T) {
		raw := `{"action":"chat","parameters":{"message":"hi"}}`
		var env actionEnvelope
		if err := json.Unmarshal([]byte(raw), &env); err != nil {
			t.Fatal(err)
		}
		if env.Id != "" || env.TimeoutMs != 0 {
			t.Fatalf("expected empty id/timeout, got id=%q timeoutMs=%d", env.Id, env.TimeoutMs)
		}
		inst, err := pull.DecodeAction(env.Action, env.Parameters)
		if err != nil {
			t.Fatal(err)
		}
		if inst.Name() != "chat" {
			t.Fatalf("got %s", inst.Name())
		}
	})

	t.Run("with id and timeoutMs", func(t *testing.T) {
		raw := `{"action":"getState","parameters":{},"id":"req-1","timeoutMs":1500}`
		var env actionEnvelope
		if err := json.Unmarshal([]byte(raw), &env); err != nil {
			t.Fatal(err)
		}
		if env.Id != "req-1" || env.TimeoutMs != 1500 {
			t.Fatalf("unexpected envelope: %+v", env)
		}
		inst, err := pull.DecodeAction(env.Action, env.Parameters)
		if err != nil {
			t.Fatal(err)
		}
		if inst.Name() != "getState" {
			t.Fatalf("got %s", inst.Name())
		}
	})

	t.Run("unknown action", func(t *testing.T) {
		_, err := pull.DecodeAction("notARealAction", json.RawMessage(`{}`))
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "unregistered instruction") {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("legacy Decode still works", func(t *testing.T) {
		inst, err := pull.Decode(`{"action":"jump","parameters":{}}`)
		if err != nil {
			t.Fatal(err)
		}
		if inst.Name() != "jump" {
			t.Fatalf("got %s", inst.Name())
		}
	})
}

func TestMarshalStatusEnvelope(t *testing.T) {
	t.Run("omits id and data when empty", func(t *testing.T) {
		b, err := MarshalStatusEnvelope("", StatusSuccess, "", nil)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		if _, ok := m["id"]; ok {
			t.Fatalf("id should be omitted: %s", b)
		}
		if _, ok := m["data"]; ok {
			t.Fatalf("data should be omitted: %s", b)
		}
		if m["status"] != StatusSuccess {
			t.Fatalf("status=%v", m["status"])
		}
	})

	t.Run("includes id and data when set", func(t *testing.T) {
		b, err := MarshalStatusEnvelope("abc", StatusSuccess, "ok", map[string]any{"n": 1})
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		if m["id"] != "abc" {
			t.Fatalf("id=%v", m["id"])
		}
		if m["message"] != "ok" {
			t.Fatalf("message=%v", m["message"])
		}
		data, ok := m["data"].(map[string]any)
		if !ok || data["n"].(float64) != 1 {
			t.Fatalf("data=%v", m["data"])
		}
	})

	t.Run("typed nil data encodes as null", func(t *testing.T) {
		var none *int
		b, err := MarshalStatusEnvelope("x", StatusSuccess, "", none)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(b), `"data":null`) {
			t.Fatalf("expected data null, got %s", b)
		}
	})
}
