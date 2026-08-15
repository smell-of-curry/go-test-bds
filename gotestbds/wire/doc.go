// Package wire decodes join-sequence definitions a real Bedrock client uses
// to draw custom content without ever seeing a behaviour pack.
//
// Sources:
//   - GameData.CustomBlocks ([]protocol.BlockEntry) — network block palette
//   - packet.ItemRegistry / GameData.Items — item component NBT
//   - packet.SyncActorProperty / GameData.PropertyData — entity property defs
//
// Concurrency: Registries are written on the bot goroutine at join (and when
// SyncActorProperty arrives) and snapshotted into immutable viewer frames on
// that same goroutine. HTTP never reads Registries directly. Callers must not
// share a Registries pointer across goroutines without external sync.
package wire
