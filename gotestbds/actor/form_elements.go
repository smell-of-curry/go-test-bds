package actor

import (
	"encoding/json"
	"fmt"
	"slices"
	"unsafe"
)

// FormElement represents form element.
type FormElement interface {
	Text() string
	ResponseValue() any
}

// FormButton ...
type FormButton struct {
	b buttonInternals
	f *Form
}

// UnmarshalJSON ...
func (b *FormButton) UnmarshalJSON(data []byte) error {
	return json.Unmarshal(data, &b.b)
}

// Press ...
func (b *FormButton) Press() error {
	switch b.f.Type() {
	case FormTypeCustom:
		return fmt.Errorf("form should not contain buttons")
	case FormTypeMenu:
		index := slices.Index(b.f.f.Buttons, *b)
		if index == -1 {
			return fmt.Errorf("unknown button")
		}
		return b.f.submit(index)
	}

	switch *b {
	case b.f.f.Button1:
		return b.f.submit(true)
	case b.f.f.Button2:
		return b.f.submit(false)
	}
	return fmt.Errorf("unknown button")
}

// Text ...
func (b *FormButton) Text() string {
	return b.b.Text
}

// Image ...
func (b *FormButton) Image() struct {
	Type string `json:"type"`
	Data string `json:"data"`
} {
	return b.b.Image
}

// ResponseValue ...
func (b *FormButton) ResponseValue() any {
	return nil
}

// buttonInternals ...
type buttonInternals struct {
	Text  string `json:"text"`
	Image struct {
		Type string `json:"type"`
		Data string `json:"data"`
	} `json:"image"`
}

// FormLabel ...
type FormLabel struct {
	text string
}

// ResponseValue ...
func (l *FormLabel) ResponseValue() any {
	return nil
}

// UnmarshalJSON ...
func (l *FormLabel) UnmarshalJSON(data []byte) error {
	var text = struct {
		Text string `json:"text"`
	}{}
	err := json.Unmarshal(data, &text)
	l.text = text.Text
	return err
}

// Text ...
func (l *FormLabel) Text() string {
	return l.text
}

// FormInput ...
type FormInput struct {
	i     inputInternals
	value string
}

// Text ...
func (i *FormInput) Text() string {
	return i.i.Text
}

// Default ...
func (i *FormInput) Default() string {
	return i.i.Default
}

// Placeholder ...
func (i *FormInput) Placeholder() string {
	return i.i.Placeholder
}

// ResponseValue ...
func (i *FormInput) ResponseValue() any {
	return i.value
}

// SetValue ...
func (i *FormInput) SetValue(str string) {
	i.value = str
}

// UnmarshalJSON ...
func (i *FormInput) UnmarshalJSON(data []byte) error {
	err := json.Unmarshal(data, &i.i)
	i.value = i.i.Default
	return err
}

// inputInternals ...
type inputInternals struct {
	Text        string `json:"text"`
	Default     string `json:"default"`
	Placeholder string `json:"placeholder"`
}

// FormToggle ...
type FormToggle struct {
	t     toggleInternals
	value bool
}

// Text ...
func (t *FormToggle) Text() string {
	return t.t.Text
}

// Default ...
func (t *FormToggle) Default() bool {
	return t.t.Default
}

// ResponseValue ...
func (t *FormToggle) ResponseValue() any {
	return t.value
}

// SetValue ...
func (t *FormToggle) SetValue(val bool) {
	t.value = val
}

// UnmarshalJSON ...
func (t *FormToggle) UnmarshalJSON(data []byte) error {
	err := json.Unmarshal(data, &t.t)
	t.value = t.t.Default
	return err
}

// toggleInternals ...
type toggleInternals struct {
	Text    string `json:"text"`
	Default bool   `json:"default"`
}

// FormSlider ...
type FormSlider struct {
	s     sliderInternals
	value float64
}

// Text ...
func (s *FormSlider) Text() string {
	return s.s.Text
}

// Default ...
func (s *FormSlider) Default() float64 {
	return s.s.Default
}

// Min ...
func (s *FormSlider) Min() float64 {
	return s.s.Min
}

// Max ...
func (s *FormSlider) Max() float64 {
	return s.s.Max
}

// StepSize ...
func (s *FormSlider) StepSize() float64 {
	return s.s.StepSize
}

// ResponseValue ...
func (s *FormSlider) ResponseValue() any {
	return s.value
}

// SetValue ...
func (s *FormSlider) SetValue(val float64) {
	s.value = val
}

// UnmarshalJSON ...
func (s *FormSlider) UnmarshalJSON(data []byte) error {
	err := json.Unmarshal(data, &s.s)
	s.value = s.s.Default
	return err
}

// sliderInternals ...
type sliderInternals struct {
	Text     string  `json:"text"`
	Min      float64 `json:"min"`
	Max      float64 `json:"max"`
	StepSize float64 `json:"step"`
	Default  float64 `json:"default"`
}

// FormDropDown ...
type FormDropDown struct {
	d     dropdownInternals
	value int
}

// Text ...
func (d *FormDropDown) Text() string {
	return d.d.Text
}

// Default ...
func (d *FormDropDown) Default() int {
	return d.d.DefaultIndex
}

// Options ...
func (d *FormDropDown) Options() []string {
	return slices.Clone(d.d.Options)
}

// ResponseValue ...
func (d *FormDropDown) ResponseValue() any {
	return d.value
}

// SetValue ...
func (d *FormDropDown) SetValue(val int) {
	d.value = val
}

// UnmarshalJSON ...
func (d *FormDropDown) UnmarshalJSON(data []byte) error {
	err := json.Unmarshal(data, &d.d)
	d.value = d.d.DefaultIndex
	return err
}

// dropdownInternals ...
type dropdownInternals struct {
	Text         string   `json:"text"`
	Options      []string `json:"options"`
	DefaultIndex int      `json:"default"`
}

// FormStepSlider ...
type FormStepSlider struct {
	FormDropDown
}

// UnmarshalJSON ...
func (s *FormStepSlider) UnmarshalJSON(data []byte) error {
	var i sliderInternals
	err := json.Unmarshal(data, &i)
	s.d = *(*dropdownInternals)(unsafe.Pointer(&i))
	return err
}

// stepSliderInternals ...
type stepSliderInternals struct {
	Text         string   `json:"text"`
	Options      []string `json:"steps"`
	DefaultIndex int      `json:"default"`
}
