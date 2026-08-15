package actor

import (
	"sync"

	"github.com/go-gl/mathgl/mgl32"
)

// particleRingCap is the maximum number of recent particle spawns retained.
const particleRingCap = 64

// ParticleSpawn is one SpawnParticleEffect observation for the viewer.
type ParticleSpawn struct {
	Name           string
	Position       mgl32.Vec3
	Dimension      byte
	EntityUniqueID int64
}

type particleRing struct {
	mu    sync.Mutex
	items []ParticleSpawn
	seqs  []uint64
	next  uint64
}

// RecordParticleSpawn appends a particle effect spawn to the ring.
//
// @param name Effect identifier from the packet.
// @param pos World (or entity-relative) position.
// @param dimension Packet dimension byte.
// @param entityUniqueID Attached entity unique id, or -1 for absolute.
func (a *Actor) RecordParticleSpawn(name string, pos mgl32.Vec3, dimension byte, entityUniqueID int64) {
	if a.particles == nil {
		a.particles = &particleRing{}
	}
	a.particles.append(ParticleSpawn{
		Name:           name,
		Position:       pos,
		Dimension:      dimension,
		EntityUniqueID: entityUniqueID,
	})
}

// ParticleSeq returns the current write sequence of the particle ring.
func (a *Actor) ParticleSeq() uint64 {
	if a.particles == nil {
		return 0
	}
	return a.particles.seq()
}

// ParticlesFromSeq returns buffered spawns with sequence > afterSeq.
func (a *Actor) ParticlesFromSeq(afterSeq uint64) []ParticleSpawn {
	if a.particles == nil {
		return nil
	}
	return a.particles.fromSeq(afterSeq)
}

func (r *particleRing) append(p ParticleSpawn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.next++
	r.items = append(r.items, p)
	r.seqs = append(r.seqs, r.next)
	if len(r.items) > particleRingCap {
		trim := len(r.items) - particleRingCap
		r.items = append([]ParticleSpawn(nil), r.items[trim:]...)
		r.seqs = append([]uint64(nil), r.seqs[trim:]...)
	}
}

func (r *particleRing) seq() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.next
}

func (r *particleRing) fromSeq(afterSeq uint64) []ParticleSpawn {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []ParticleSpawn
	for i, seq := range r.seqs {
		if seq > afterSeq {
			out = append(out, r.items[i])
		}
	}
	return out
}
