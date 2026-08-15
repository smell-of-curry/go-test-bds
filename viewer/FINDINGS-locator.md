# Findings: locator bar packets in the pinned gophertunnel

Question: the real Bedrock client shows a "locator bar" direction arrow, fed by
the Script API `LocationWaypoint` / `EntityWaypoint`. Does the gophertunnel this
repo pins carry the packets behind that HUD, and could the bot handle them?

Pinned version (go.mod): `github.com/sandertv/gophertunnel v1.57.2-0.20260722164704-0a2ecd5633ea`.

## Packets exist, and they are already decoded

Two locator-bar packets ship in the pin, both registered in the packet pool
(`minecraft/protocol/packet/pool.go`), so the bot's connection already decodes
them on arrival today — `Bot.HandlePacket` just logs them as `unhandled packet`
at debug level and moves on.

### `packet.LocatorBar` (`IDLocatorBar`) — the waypoint feed

`minecraft/protocol/packet/locator_bar.go` + `minecraft/protocol/waypoint.go`.
Sent by the server to add/remove/update waypoints on the client's locator bar:

- `Waypoints []protocol.LocatorBarWaypoint`, each carrying a `GroupHandle`
  (UUID), an `Action` (`WaypointActionAdd`/`Remove`/`Update`), and a
  `protocol.Waypoint` with a flag-gated optional set: `Visible`,
  `WorldPosition` (Vec3 + dimension), `TexturePath`, `IconSize`, `Colour`,
  `ClientPositionAuthority`, `ActorUniqueID`.

The optional fields map one-to-one onto the Script API surface: a
`LocationWaypoint` is `WorldPosition` + `Colour`/`TexturePath`, an
`EntityWaypoint` is `ActorUniqueID` tracking. That field-shape match makes
`LocatorBar` the near-certain carrier for scripted waypoints; worth a one-run
confirmation by watching the bot's `unhandled packet` debug log while a suite
sets a `LocationWaypoint`.

### `packet.PlayerLocation` (`IDPlayerLocation`) — player dots

`minecraft/protocol/packet/player_location.go`. Updates or hides a player's
position on the locator bar (`Type` coordinates/hide, `EntityUniqueID`,
`Position`). This is the vanilla players-on-the-bar feed, not the scripted
waypoint one.

## Decode feasibility

No work: the pool already constructs and unmarshals both types; there is no
sub-chunk-style sentinel weirdness, no NBT, no hashes — plain flag-gated
optionals. Handling is the standard pattern: a `handler_locator_bar.go`
registered in `Bot.registerHandlers`, storing waypoint state keyed by
`GroupHandle` on the actor/world, plus (optionally) an observation instruction
and a snapshot field so the viewer can draw the arrow.

## Recommendation

Wire `LocatorBar` when the instruction/stream owner has room: small, low-risk,
and it gives tests a client-observed assertion ("the player was actually shown
a waypoint") that no server-side check can provide. `PlayerLocation` is lower
value (bots rarely care where other players' dots are) — skip until a test
needs it. Until then the suite-driven waypoint `mark` frames remain the
fallback for pointing at things in recordings.

Not done here by design: packet handling belongs to the instruction/stream
surface, which another agent owns.
