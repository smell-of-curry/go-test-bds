// Package assets resolves Minecraft Bedrock resource packs for the viewer.
//
// Two sources only: a pinned Mojang/bedrock-samples vanilla baseline, and
// resource packs the server sends over the wire. Behaviour packs are never an
// input. Go serves bytes and resolves paths; the browser does all decoding.
//
// The package is inert until a Manager is constructed — a run with the viewer
// disabled must not download packs, touch the cache, or allocate a stack.
package assets
