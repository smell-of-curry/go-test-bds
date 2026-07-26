package leveldat_test

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"

	"github.com/sandertv/gophertunnel/minecraft/nbt"
	"github.com/smell-of-curry/go-test-bds/internal/leveldat"
)

// writeFixture builds a minimal Bedrock level.dat with an 8-byte header and a
// little-endian NBT payload containing LevelName plus an empty experiments map.
func writeFixture(t *testing.T, path string, storageVersion int32) {
	t.Helper()
	root := map[string]any{
		"LevelName":   "e2e",
		"experiments": map[string]any{},
	}
	body, err := nbt.MarshalEncoding(root, nbt.LittleEndian)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	raw := make([]byte, 8+len(body))
	binary.LittleEndian.PutUint32(raw[0:4], uint32(storageVersion))
	binary.LittleEndian.PutUint32(raw[4:8], uint32(len(body)))
	copy(raw[8:], body)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
}

func TestEnsureExperimentsFlipsFlags(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "level.dat")
	const storageVersion int32 = 10
	writeFixture(t, path, storageVersion)

	if err := leveldat.EnsureExperiments(path); err != nil {
		t.Fatalf("EnsureExperiments: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read patched: %v", err)
	}
	if got := int32(binary.LittleEndian.Uint32(raw[0:4])); got != storageVersion {
		t.Fatalf("storage version: got %d want %d", got, storageVersion)
	}
	if got := binary.LittleEndian.Uint32(raw[4:8]); got != uint32(len(raw)-8) {
		t.Fatalf("payload length header: got %d want %d", got, len(raw)-8)
	}

	root := map[string]any{}
	if err := nbt.UnmarshalEncoding(raw[8:], &root, nbt.LittleEndian); err != nil {
		t.Fatalf("unmarshal patched: %v", err)
	}
	if root["LevelName"] != "e2e" {
		t.Fatalf("LevelName not preserved: %#v", root["LevelName"])
	}
	experiments, ok := root["experiments"].(map[string]any)
	if !ok {
		t.Fatalf("experiments missing or wrong type: %#v", root["experiments"])
	}
	for _, key := range leveldat.RequiredExperiments {
		v, present := experiments[key]
		if !present {
			t.Fatalf("missing experiment flag %q", key)
		}
		asByte, ok := v.(byte)
		if !ok || asByte != 1 {
			t.Fatalf("experiment %q: got %#v want byte(1)", key, v)
		}
	}
}

func TestEnsureExperimentsCreatesMissingCompound(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "level.dat")

	body, err := nbt.MarshalEncoding(map[string]any{"LevelName": "bare"}, nbt.LittleEndian)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	raw := make([]byte, 8+len(body))
	binary.LittleEndian.PutUint32(raw[0:4], 8)
	binary.LittleEndian.PutUint32(raw[4:8], uint32(len(body)))
	copy(raw[8:], body)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	if err := leveldat.EnsureExperiments(path); err != nil {
		t.Fatalf("EnsureExperiments: %v", err)
	}

	patched, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	root := map[string]any{}
	if err := nbt.UnmarshalEncoding(patched[8:], &root, nbt.LittleEndian); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	experiments, ok := root["experiments"].(map[string]any)
	if !ok {
		t.Fatalf("experiments not created: %#v", root["experiments"])
	}
	if experiments["gametest"] != byte(1) {
		t.Fatalf("gametest not set: %#v", experiments["gametest"])
	}
}
