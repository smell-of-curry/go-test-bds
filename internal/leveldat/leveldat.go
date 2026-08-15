// Package leveldat patches Bedrock Dedicated Server level.dat files so Script
// API experiment toggles are enabled before a behavior pack's scripts load.
package leveldat

import (
	"encoding/binary"
	"fmt"
	"os"

	"github.com/sandertv/gophertunnel/minecraft/nbt"
)

// RequiredExperiments are the level.dat experiment keys a Script API pack needs.
//
// `gametest` is the "Beta APIs" toggle — without it BDS refuses script modules
// that depend on beta `@minecraft/server`. The rest mirror the set used by
// production PokeBedrock worlds (see bds-manager's levelDat helper).
var RequiredExperiments = []string{
	"gametest",
	"data_driven_biomes",
	"experimental_creator_cameras",
	"jigsaw_structures",
	"upcoming_creator_features",
	"villager_trades_rebalance",
	"experiments_ever_used",
	"saved_with_toggled_experiments",
}

// EnsureExperiments enables the required experiment toggles in a Bedrock
// level.dat.
//
// Bedrock level.dat = 8-byte header (storage version + payload length, both
// little-endian int32) followed by uncompressed little-endian NBT.
//
// @param path Absolute or relative path to the world's level.dat.
// @returns nil on success.
// @throws an error if the file is missing, truncated, or not parseable as
// Bedrock little-endian NBT.
func EnsureExperiments(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if len(raw) < 8 {
		return fmt.Errorf("level.dat too short: %d bytes", len(raw))
	}

	storageVersion := int32(binary.LittleEndian.Uint32(raw[0:4]))
	payload := raw[8:]

	root := map[string]any{}
	if err := nbt.UnmarshalEncoding(payload, &root, nbt.LittleEndian); err != nil {
		return fmt.Errorf("parse level.dat nbt: %w", err)
	}

	experiments, _ := root["experiments"].(map[string]any)
	if experiments == nil {
		experiments = map[string]any{}
	}
	for _, key := range RequiredExperiments {
		experiments[key] = byte(1)
	}
	root["experiments"] = experiments

	body, err := nbt.MarshalEncoding(root, nbt.LittleEndian)
	if err != nil {
		return fmt.Errorf("encode level.dat nbt: %w", err)
	}

	out := make([]byte, 8+len(body))
	binary.LittleEndian.PutUint32(out[0:4], uint32(storageVersion))
	binary.LittleEndian.PutUint32(out[4:8], uint32(len(body)))
	copy(out[8:], body)

	return os.WriteFile(path, out, 0o644)
}
