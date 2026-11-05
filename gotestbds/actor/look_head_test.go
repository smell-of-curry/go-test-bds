package actor

import (
	"math"
	"testing"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/go-gl/mathgl/mgl32"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
)

type lookRecordingConn struct {
	navStubConn
	written []packet.Packet
}

func (c *lookRecordingConn) WritePacket(pk packet.Packet) error {
	c.written = append(c.written, pk)
	return nil
}

func newLookActor(t *testing.T) (*Actor, *lookRecordingConn) {
	t.Helper()
	conn := &lookRecordingConn{navStubConn: navStubConn{pos: mgl32.Vec3{10, 65, 20}}}
	a := Config{Conn: conn}.New()
	t.Cleanup(func() { _ = a.Close() })
	conn.written = nil
	return a, conn
}

func lookAuthInput(t *testing.T, conn *lookRecordingConn) *packet.PlayerAuthInput {
	t.Helper()
	if len(conn.written) != 1 {
		t.Fatalf("sent %d packets, want one PlayerAuthInput", len(conn.written))
	}
	pk, ok := conn.written[0].(*packet.PlayerAuthInput)
	if !ok {
		t.Fatalf("sent %T, want PlayerAuthInput", conn.written[0])
	}
	return pk
}

// A look must be visible locally before the next input tick, and the following
// packet must agree. The east-facing case reproduces a head left at zero while
// the body faces -90/270 degrees; the diagonal also checks nonzero pitch.
func TestLookAtUpdatesLocalHeadAndSentInput(t *testing.T) {
	for _, tc := range []struct {
		name      string
		direction mgl64.Vec3
		rotation  cube.Rotation
	}{
		{"east", mgl64.Vec3{10, 0, 0}, cube.Rotation{270, 0}},
		{"west", mgl64.Vec3{-10, 0, 0}, cube.Rotation{90, 0}},
		{"north", mgl64.Vec3{0, 0, -10}, cube.Rotation{180, 0}},
		{"up southeast", mgl64.Vec3{10, math.Sqrt(200), 10}, cube.Rotation{315, -45}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, conn := newLookActor(t)
			position := a.Position()
			a.SetHeadYaw(17)
			a.LookAt(a.EyePos().Add(tc.direction))
			if math.Abs(a.Rotation().Yaw()-tc.rotation.Yaw()) > 1e-6 || math.Abs(a.Rotation().Pitch()-tc.rotation.Pitch()) > 1e-6 {
				t.Fatalf("look rotation = %v, want %v", a.Rotation(), tc.rotation)
			}
			if a.HeadYaw() != a.Rotation().Yaw() {
				t.Fatalf("head yaw = %v, body yaw = %v before send", a.HeadYaw(), a.Rotation().Yaw())
			}
			if a.Position() != position || len(conn.written) != 0 {
				t.Fatal("LookAt moved the actor or sent a packet before SendMovement")
			}
			a.SendMovement()
			pk := lookAuthInput(t, conn)
			if pk.Yaw != float32(tc.rotation.Yaw()) || pk.Pitch != float32(tc.rotation.Pitch()) || pk.HeadYaw != pk.Yaw {
				t.Fatalf("input yaw/pitch/head = %v/%v/%v, want %v/%v/%v", pk.Yaw, pk.Pitch, pk.HeadYaw, tc.rotation.Yaw(), tc.rotation.Pitch(), tc.rotation.Yaw())
			}
			if a.HeadYaw() != float64(pk.HeadYaw) {
				t.Fatalf("recorded head yaw = %v, sent = %v", a.HeadYaw(), pk.HeadYaw)
			}
		})
	}
}

type lookMoveHandler struct {
	NopHandler
	cancel   bool
	rotation cube.Rotation
}

func (h lookMoveHandler) HandleMove(ctx *Context, rotation *cube.Rotation, _ *mgl64.Vec3) {
	if h.cancel {
		ctx.Cancel()
		return
	}
	*rotation = h.rotation
}

func TestLookAtUsesAcceptedRotationAndHonorsCancellation(t *testing.T) {
	a, conn := newLookActor(t)
	a.Move(a.Position(), cube.Rotation{30, 10})
	a.SetHeadYaw(80)
	a.Handle(lookMoveHandler{cancel: true})
	a.LookAt(a.EyePos().Add(mgl64.Vec3{10, 0, 0}))
	if a.Rotation() != (cube.Rotation{30, 10}) || a.HeadYaw() != 80 {
		t.Fatalf("cancelled look changed rotation/head to %v/%v", a.Rotation(), a.HeadYaw())
	}

	accepted := cube.Rotation{123, -20}
	a.Handle(lookMoveHandler{rotation: accepted})
	a.LookAt(a.EyePos().Add(mgl64.Vec3{10, 0, 0}))
	if a.Rotation() != accepted || a.HeadYaw() != accepted.Yaw() {
		t.Fatalf("adjusted look = %v, head = %v; want %v", a.Rotation(), a.HeadYaw(), accepted)
	}
	a.SendMovement()
	pk := lookAuthInput(t, conn)
	if pk.HeadYaw != 123 || pk.Yaw != 123 || pk.Pitch != -20 {
		t.Fatalf("adjusted look sent inconsistent input: %#v", pk)
	}
}

func TestSendMovementSynchronizesOnlyLocalHead(t *testing.T) {
	a, conn := newLookActor(t)
	remote := entity.NewEnt(mgl64.Vec3{12, 64, 20}, nil, 2, 2, "minecraft:player")
	remote.SetHeadYaw(85)
	remote.Move(remote.Position(), cube.Rotation{-90, 0})
	a.World().AddEntity(remote)
	// Generic entity movement must preserve independent remote head direction.
	if remote.HeadYaw() != 85 {
		t.Fatal("remote entity Move overwrote its independent head yaw")
	}

	for _, yaw := range []float64{-90, 37.123456789} {
		conn.written = nil
		a.Move(a.Position(), cube.Rotation{yaw, -12})
		a.SetHeadYaw(0)
		a.SendMovement()
		pk := lookAuthInput(t, conn)
		if pk.HeadYaw != float32(yaw) || pk.Yaw != float32(yaw) || a.HeadYaw() != float64(pk.HeadYaw) {
			t.Fatalf("local/sent head = %v/%v, input yaw = %v", a.HeadYaw(), pk.HeadYaw, pk.Yaw)
		}
	}
	if remote.HeadYaw() != 85 || remote.Rotation().Yaw() != -90 {
		t.Fatalf("local movement changed remote head/body: %v/%v", remote.HeadYaw(), remote.Rotation().Yaw())
	}
}
