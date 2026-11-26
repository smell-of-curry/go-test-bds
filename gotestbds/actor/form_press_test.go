package actor

import (
	"testing"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

type formResponseConn struct {
	Conn
	response *packet.ModalFormResponse
}

func (c *formResponseConn) WritePacket(p packet.Packet) error {
	c.response = p.(*packet.ModalFormResponse)
	return nil
}

func TestPressSecondIdenticalButton(t *testing.T) {
	for _, tc := range []struct{ name, json, expected string }{
		{"menu", `{"type":"form","buttons":[{"text":"slot"},{"text":"slot"}]}`, "1"},
		{"modal", `{"type":"modal","button1":"slot","button2":"slot"}`, "false"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &formResponseConn{}
			f, err := NewForm([]byte(tc.json), 7, c)
			if err != nil {
				t.Fatal(err)
			}
			var selected FormButton
			if buttons, ok := f.MenuFormButtons(); ok {
				selected = buttons[1]
			} else {
				_, second, _ := f.ModalFormButtons()
				selected = *second
			}
			if err := selected.Press(); err != nil {
				t.Fatal(err)
			}
			data, present := c.response.ResponseData.Value()
			if c.response.FormID != 7 || !present || string(data) != tc.expected {
				t.Fatalf("received form %d, response %q; want form 7, response %s", c.response.FormID, data, tc.expected)
			}
		})
	}
}
