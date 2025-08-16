package actor

// FormType ...
type FormType string

const (
	FormTypeCustom FormType = "custom_form"
	FormTypeModal  FormType = "modal"
	FormTypeMenu   FormType = "form"
)

// modalForm ...
type modalForm struct {
	Button1 FormButton `json:"button1"`
	Button2 FormButton `json:"button2"`
}

// menuForm ...
type menuForm struct {
	Buttons []FormButton `json:"buttons"`
}

// customForm ...
type customForm struct {
	Content Content `json:"content"`
}
