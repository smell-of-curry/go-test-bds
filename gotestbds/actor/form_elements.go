package actor

import (
	"encoding/json"
	"fmt"
	"slices"
	"unsafe"
)

// FormElement ...
type FormElement interface {
	Text() string
	ResponseValue() any
}

// Button ...
type Button struct {
	b buttonInternals
	f *Form
}

// UnmarshalJSON ...
func (b *Button) UnmarshalJSON(data []byte) error {
	return json.Unmarshal(data, &b.b)
}

// Press ...
func (b *Button) Press() error {
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
func (b *Button) Text() string {
	return b.b.Text
}

// Image ...
func (b *Button) Image() struct {
	Type string `json:"type"`
	Data string `json:"data"`
} {
	return b.b.Image
}

// ResponseValue ...
func (b *Button) ResponseValue() any {
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

// Label ...
type Label struct {
	text string
}

// ResponseValue ...
func (l *Label) ResponseValue() any {
	return nil
}

// UnmarshalJSON ...
func (l *Label) UnmarshalJSON(data []byte) error {
	var text = struct {
		Text string `json:"text"`
	}{}
	err := json.Unmarshal(data, &text)
	l.text = text.Text
	return err
}

// Text ...
func (l *Label) Text() string {
	return l.text
}

// Input ...
type Input struct {
	i     inputInternals
	value string
}

// Text ...
func (i *Input) Text() string {
	return i.i.Text
}

// Default ...
func (i *Input) Default() string {
	return i.i.Default
}

// Placeholder ...
func (i *Input) Placeholder() string {
	return i.i.Placeholder
}

// ResponseValue ...
func (i *Input) ResponseValue() any {
	return i.value
}

// SetValue ...
func (i *Input) SetValue(str string) {
	i.value = str
}

// UnmarshalJSON ...
func (i *Input) UnmarshalJSON(data []byte) error {
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

// Toggle ...
type Toggle struct {
	t     toggleInternals
	value bool
}

// Text ...
func (t *Toggle) Text() string {
	return t.t.Text
}

// Default ...
func (t *Toggle) Default() bool {
	return t.t.Default
}

// ResponseValue ...
func (t *Toggle) ResponseValue() any {
	return t.value
}

// SetValue ...
func (t *Toggle) SetValue(val bool) {
	t.value = val
}

// UnmarshalJSON ...
func (t *Toggle) UnmarshalJSON(data []byte) error {
	err := json.Unmarshal(data, &t.t)
	t.value = t.t.Default
	return err
}

// toggleInternals ...
type toggleInternals struct {
	Text    string `json:"text"`
	Default bool   `json:"default"`
}

// Slider ...
type Slider struct {
	s     sliderInternals
	value float64
}

// Text ...
func (s *Slider) Text() string {
	return s.s.Text
}

// Default ...
func (s *Slider) Default() float64 {
	return s.s.Default
}

// Min ...
func (s *Slider) Min() float64 {
	return s.s.Min
}

// Max ...
func (s *Slider) Max() float64 {
	return s.s.Max
}

// StepSize ...
func (s *Slider) StepSize() float64 {
	return s.s.StepSize
}

// ResponseValue ...
func (s *Slider) ResponseValue() any {
	return s.value
}

// SetValue ...
func (s *Slider) SetValue(val float64) {
	s.value = val
}

// UnmarshalJSON ...
func (s *Slider) UnmarshalJSON(data []byte) error {
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

// DropDown ...
type DropDown struct {
	d     dropdownInternals
	value int
}

// Text ...
func (d *DropDown) Text() string {
	return d.d.Text
}

// Default ...
func (d *DropDown) Default() int {
	return d.d.DefaultIndex
}

// Options ...
func (d *DropDown) Options() []string {
	return slices.Clone(d.d.Options)
}

// ResponseValue ...
func (d *DropDown) ResponseValue() any {
	return d.value
}

// SetValue ...
func (d *DropDown) SetValue(val int) {
	d.value = val
}

// UnmarshalJSON ...
func (d *DropDown) UnmarshalJSON(data []byte) error {
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

// StepSlider ...
type StepSlider struct {
	DropDown
}

func (s *StepSlider) UnmarshalJSON(data []byte) error {
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
