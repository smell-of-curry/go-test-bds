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
	Button1 Button `json:"button1"`
	Button2 Button `json:"button2"`
}

// menuForm ...
type menuForm struct {
	Buttons []Button `json:"buttons"`
}

// customForm ...
type customForm struct {
	Content Content `json:"content"`
}
