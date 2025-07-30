package attributes

import "github.com/sandertv/gophertunnel/minecraft/protocol"

// Values is an attribute values on the server side.
type Values struct {
	speed float64

	hunger     float64
	saturation float64
	exhaustion float64

	health     float64
	absorption float64

	level      float64
	experience float64
}

// Speed ...
func (c *Values) Speed() float64 {
	return c.speed
}

// Food ...
func (c *Values) Food() float64 {
	return c.hunger
}

// Saturation ...
func (c *Values) Saturation() float64 {
	return c.saturation
}

// Exhaustion ...
func (c *Values) Exhaustion() float64 {
	return c.exhaustion
}

// Health ...
func (c *Values) Health() float64 {
	return c.health
}

// Absorption ...
func (c *Values) Absorption() float64 {
	return c.absorption
}

// Level ...
func (c *Values) Level() float64 {
	return c.level
}

// Experience ...
func (c *Values) Experience() float64 {
	return c.experience
}

// Decode ...
func (c *Values) Decode(attributes []protocol.Attribute) {
	for _, attr := range attributes {
		val := float64(attr.Value)
		switch attr.Name {
		case "minecraft:movement":
			c.speed = val
		case "minecraft:player.hunger":
			c.hunger = val
		case "minecraft:player.saturation":
			c.saturation = val
		case "minecraft:player.exhaustion":
			c.exhaustion = val
		case "minecraft:health":
			c.health = val
		case "minecraft:absorption":
			c.absorption = val
		case "minecraft:player.level":
			c.level = val
		case "minecraft:player.experience":
			c.experience = val
		}
	}
}
