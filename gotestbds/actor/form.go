package actor

import (
	"encoding/json"
	"fmt"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// NewForm ...
func NewForm(data []byte, id uint32, conn Conn) (*Form, error) {
	f := &Form{id: id, conn: conn}

	err := json.Unmarshal(data, f)
	return f, err
}

// Form ...
type Form struct {
	conn     Conn
	used     bool
	id       uint32
	formType FormType
	title    string
	// raw keeps the payload the server sent. A form that parses into something
	// unusable is only diagnosable from its original JSON, and the bot sees
	// whatever shape the addon under test chose to send.
	raw []byte
	f   formInternals
}

// Raw returns the JSON the server sent for this form.
func (f *Form) Raw() string {
	return string(f.raw)
}

// UnmarshalJSON ...
func (f *Form) UnmarshalJSON(data []byte) error {
	header := struct {
		Title Text   `json:"title"`
		Type  string `json:"type"`
	}{}
	err := json.Unmarshal(data, &header)
	if err != nil {
		return err
	}

	f.title = header.Title.String()
	f.formType = FormType(header.Type)
	f.raw = data

	switch f.Type() {
	case FormTypeMenu:
		err = json.Unmarshal(data, &f.f.menuForm)
		for i := range f.f.Buttons {
			f.f.Buttons[i].f = f
		}
	case FormTypeModal:
		err = json.Unmarshal(data, &f.f.modalForm)
		f.f.Button1.f = f
		f.f.Button2.f = f
	case FormTypeCustom:
		err = json.Unmarshal(data, &f.f.customForm)
		f.f.Content.f = f
	}
	// Returning this used to be skipped, which turned a form whose body failed
	// to parse into a silently empty one — the caller then reported "0 buttons"
	// with no hint that decoding had failed at all.
	return err
}

// Type ...
func (f *Form) Type() FormType {
	return f.formType
}

// Title ...
func (f *Form) Title() string {
	return f.title
}

// CustomFormContent ...
func (f *Form) CustomFormContent() (*Content, bool) {
	if f.Type() != FormTypeCustom {
		return nil, false
	}
	return &f.f.Content, true
}

// MenuFormButtons ...
func (f *Form) MenuFormButtons() ([]FormButton, bool) {
	if f.Type() != FormTypeMenu {
		return nil, false
	}
	return f.f.Buttons, true
}

// ModalFormButtons ...
func (f *Form) ModalFormButtons() (yes *FormButton, no *FormButton, ok bool) {
	if f.Type() != FormTypeModal {
		return
	}
	return &f.f.Button1, &f.f.Button2, true
}

// Ignore ...
func (f *Form) Ignore() error {
	return f.submit(nil)
}

// use ...
func (f *Form) use() error {
	if f.used {
		return fmt.Errorf("form has already been used")
	}
	f.used = true
	return nil
}

// submit sends ModalFormResponse packet.
func (f *Form) submit(data any) error {
	if err := f.use(); err != nil {
		return err
	}

	response := &packet.ModalFormResponse{
		FormID: f.id,
	}
	if data != nil {
		bytes, err := json.Marshal(data)
		if err != nil {
			return err
		}
		response.ResponseData = protocol.Option(bytes)
	} else {
		response.CancelReason = protocol.Option(uint8(packet.ModalFormCancelReasonUserClosed))
	}

	return f.conn.WritePacket(response)
}

// formInternals ...
type formInternals struct {
	customForm
	menuForm
	modalForm
}
