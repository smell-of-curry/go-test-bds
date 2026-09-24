package actor

import "testing"

// TestMenuFormParsesButtons pins the shape a Bedrock ActionFormData arrives in.
func TestMenuFormParsesButtons(t *testing.T) {
	for name, data := range map[string]string{
		"plain": `{"type":"form","title":"GoTestBDS E2E","content":"body","buttons":[{"text":"Confirm"},{"text":"Cancel"}]}`,
		"rawtextTitle": `{"type":"form","title":{"rawtext":[{"text":"GoTestBDS E2E"}]},"content":"body",` +
			`"buttons":[{"text":"Confirm"},{"text":"Cancel"}]}`,
		"rawtextButtons": `{"type":"form","title":"GoTestBDS E2E","content":"body",` +
			`"buttons":[{"text":{"rawtext":[{"text":"Confirm"}]}},{"text":{"rawtext":[{"text":"Cancel"}]}}]}`,
		"buttonImage": `{"type":"form","title":"GoTestBDS E2E","content":"body",` +
			`"buttons":[{"text":"Confirm","image":{"type":"path","data":"textures/ui/confirm"}},{"text":"Cancel"}]}`,
		// What current Bedrock builds actually send, captured from a live BDS.
		"elements": `{"content":"body","elements":[{"image":null,"text":"Confirm","type":"button"},` +
			`{"image":null,"text":"Cancel","type":"button"}],"title":"GoTestBDS E2E","type":"form"}`,
		"elementsRawtext": `{"content":"body","elements":[` +
			`{"image":null,"text":{"rawtext":[{"text":"Confirm"}]},"type":"button"},` +
			`{"image":null,"text":"Cancel","type":"button"}],"title":"GoTestBDS E2E","type":"form"}`,
	} {
		t.Run(name, func(t *testing.T) {
			f, err := NewForm([]byte(data), 1, nil)
			if err != nil {
				t.Fatalf("NewForm: %v", err)
			}
			if f.Title() != "GoTestBDS E2E" {
				t.Fatalf("title = %q", f.Title())
			}
			buttons, ok := f.MenuFormButtons()
			if !ok {
				t.Fatalf("form type %q is not a menu", f.Type())
			}
			if len(buttons) != 2 {
				t.Fatalf("got %d buttons, want 2 (raw: %s)", len(buttons), f.Raw())
			}
			if buttons[0].Text() != "Confirm" {
				t.Fatalf("button 0 = %q", buttons[0].Text())
			}
		})
	}
}

// TestModalFormParsesButtons pins MessageFormData / modal payload shapes.
func TestModalFormParsesButtons(t *testing.T) {
	for name, data := range map[string]string{
		// Script API MessageFormData: button1/button2 are plain strings.
		"stringButtons": `{"type":"modal","title":"GoTestBDS Modal","content":"body","button1":"Yes","button2":"No"}`,
		"objectButtons": `{"type":"modal","title":"GoTestBDS Modal","content":"body",` +
			`"button1":{"text":"Yes"},"button2":{"text":"No"}}`,
		"rawtextTitle": `{"type":"modal","title":{"rawtext":[{"text":"GoTestBDS Modal"}]},"content":"body",` +
			`"button1":"Yes","button2":"No"}`,
	} {
		t.Run(name, func(t *testing.T) {
			f, err := NewForm([]byte(data), 1, nil)
			if err != nil {
				t.Fatalf("NewForm: %v", err)
			}
			if f.Title() != "GoTestBDS Modal" {
				t.Fatalf("title = %q", f.Title())
			}
			yes, no, ok := f.ModalFormButtons()
			if !ok {
				t.Fatalf("form type %q is not a modal", f.Type())
			}
			if yes.Text() != "Yes" {
				t.Fatalf("button1 = %q", yes.Text())
			}
			if no.Text() != "No" {
				t.Fatalf("button2 = %q", no.Text())
			}
		})
	}
}
