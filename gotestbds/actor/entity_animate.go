package actor

import "sync"

// entityAnimRingCap is the maximum number of recent AnimateEntity packets retained.
const entityAnimRingCap = 64

// EntityAnimate is one AnimateEntity observation for the viewer.
type EntityAnimate struct {
	Animation      string
	NextState      string
	StopExpression string
	Controller     string
	BlendOutTime   float32
	RuntimeIDs     []uint64
}

type entityAnimRing struct {
	mu    sync.Mutex
	items []EntityAnimate
	seqs  []uint64
	next  uint64
}

// RecordEntityAnimate appends one server-triggered animation to the ring.
//
// @param ev Packet fields. RuntimeIDs is retained as given.
func (a *Actor) RecordEntityAnimate(ev EntityAnimate) {
	if a.entityAnims == nil {
		a.entityAnims = &entityAnimRing{}
	}
	a.entityAnims.append(ev)
}

// EntityAnimSeq returns the current write sequence of the animation ring.
func (a *Actor) EntityAnimSeq() uint64 {
	if a.entityAnims == nil {
		return 0
	}
	return a.entityAnims.seq()
}

// EntityAnimsFromSeq returns buffered animations with sequence > afterSeq.
func (a *Actor) EntityAnimsFromSeq(afterSeq uint64) []EntityAnimate {
	if a.entityAnims == nil {
		return nil
	}
	return a.entityAnims.fromSeq(afterSeq)
}

func (r *entityAnimRing) append(ev EntityAnimate) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.next++
	r.items = append(r.items, ev)
	r.seqs = append(r.seqs, r.next)
	if len(r.items) > entityAnimRingCap {
		trim := len(r.items) - entityAnimRingCap
		r.items = append([]EntityAnimate(nil), r.items[trim:]...)
		r.seqs = append([]uint64(nil), r.seqs[trim:]...)
	}
}

func (r *entityAnimRing) seq() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.next
}

func (r *entityAnimRing) fromSeq(afterSeq uint64) []EntityAnimate {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []EntityAnimate
	for i, seq := range r.seqs {
		if seq > afterSeq {
			out = append(out, r.items[i])
		}
	}
	return out
}
