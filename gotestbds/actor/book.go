package actor

import (
	"fmt"

	"github.com/df-mc/dragonfly/server/item"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// BookAction represents action that can be executed on book.
type BookAction interface {
	Perform(book item.BookAndQuill, actor *Actor) (*packet.BookEdit, error)
}

// BookActionReplacePage performs replace action.
type BookActionReplacePage struct {
	Page int    `json:"page"`
	Text string `json:"text"`
}

// Perform ...
func (b BookActionReplacePage) Perform(book item.BookAndQuill, actor *Actor) (*packet.BookEdit, error) {
	if b.Page > 50 {
		return nil, ErrInvalidBookPage{b.Page}
	}
	return &packet.BookEdit{
		ActionType: packet.BookActionReplacePage,
		Text:       b.Text,
	}, nil
}

// BookActionAddPage performs add page action.
type BookActionAddPage struct {
	Page int    `json:"page"`
	Text string `json:"text"`
}

// Perform ...
func (b BookActionAddPage) Perform(book item.BookAndQuill, actor *Actor) (*packet.BookEdit, error) {
	if b.Page >= 50 {
		return nil, ErrInvalidBookPage{b.Page}
	}
	return &packet.BookEdit{
		ActionType: packet.BookActionAddPage,
		PageNumber: byte(b.Page),
		Text:       b.Text,
	}, nil
}

// BookActionDeletePage performs page deletion.
type BookActionDeletePage struct {
	Page int `json:"page"`
}

// Perform ...
func (b BookActionDeletePage) Perform(book item.BookAndQuill, actor *Actor) (*packet.BookEdit, error) {
	if _, ok := book.Page(b.Page); !ok {
		return nil, ErrInvalidBookPage{b.Page}
	}
	return &packet.BookEdit{
		ActionType: packet.BookActionDeletePage,
		PageNumber: byte(b.Page),
	}, nil
}

// BookActionSwapPages perform swap action.
type BookActionSwapPages struct {
	Page          int `json:"page"`
	SecondaryPage int `json:"secondaryPage"`
}

// Perform ...
func (b BookActionSwapPages) Perform(book item.BookAndQuill, actor *Actor) (*packet.BookEdit, error) {
	if b.Page > 50 {
		return nil, ErrInvalidBookPage{b.Page}
	}
	if b.SecondaryPage > 50 {
		return nil, ErrInvalidBookPage{b.SecondaryPage}
	}
	return &packet.BookEdit{
		ActionType:          packet.BookActionSign,
		PageNumber:          byte(b.Page),
		SecondaryPageNumber: byte(b.SecondaryPage),
	}, nil
}

// BookActionSign signs book.
type BookActionSign struct {
	Title string `json:"title"`
}

// Perform ...
func (b BookActionSign) Perform(book item.BookAndQuill, actor *Actor) (*packet.BookEdit, error) {
	return &packet.BookEdit{
		ActionType: packet.BookActionSign,
		Title:      b.Title,
		Author:     actor.Name(),
		XUID:       actor.conn.IdentityData().XUID,
	}, nil
}

// ErrInvalidBookPage ...
type ErrInvalidBookPage struct {
	Page int
}

// Error ...
func (e ErrInvalidBookPage) Error() string {
	return fmt.Sprintf("invalid book page %d", e.Page)
}
