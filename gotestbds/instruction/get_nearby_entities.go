package instruction

import (
	"context"
	"sort"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// GetNearbyEntities returns entities within a radius of the bot.
type GetNearbyEntities struct {
	Radius float64 `json:"radius"`
	result any
}

// Name returns the instruction name.
func (*GetNearbyEntities) Name() string {
	return "getNearbyEntities"
}

// nearbyEntityJSON is one nearby entity in the observation payload.
type nearbyEntityJSON struct {
	RuntimeID uint64   `json:"runtimeId"`
	Type      string   `json:"type"`
	Name      string   `json:"name,omitempty"`
	Position  Vec3JSON `json:"position"`
	Distance  float64  `json:"distance"`
}

// Run collects entities within Radius (default 16) sorted by ascending distance.
func (g *GetNearbyEntities) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		radius := g.Radius
		if radius == 0 {
			radius = 16
		}
		origin := a.Position()
		self := a.RuntimeID()
		var entities []nearbyEntityJSON
		for ent := range a.World().Entities() {
			if ent.RuntimeID() == self {
				continue
			}
			pos := ent.Position()
			dist := pos.Sub(origin).Len()
			if dist > radius {
				continue
			}
			entities = append(entities, nearbyEntityJSON{
				RuntimeID: ent.RuntimeID(),
				Type:      ent.Type(),
				Name:      entityDisplayName(ent),
				Position:  Vec3JSON{X: pos.X(), Y: pos.Y(), Z: pos.Z()},
				Distance:  dist,
			})
		}
		sort.Slice(entities, func(i, j int) bool {
			return entities[i].Distance < entities[j].Distance
		})
		g.result = map[string]any{"entities": entities}
		return nil
	})
}

// Data returns the nearby-entities payload from the last successful Run.
func (g *GetNearbyEntities) Data() any {
	return g.result
}

func entityDisplayName(ent world.Entity) string {
	if namer, ok := ent.(interface{ Name() string }); ok {
		if name := namer.Name(); name != "" {
			return name
		}
	}
	return ent.State().NameTag()
}
