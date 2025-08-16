package util

import (
	"fmt"
	"strings"
)

// MultiError joins multiples errors.
func MultiError(errors ...error) error {
	if len(errors) == 0 {
		return nil
	}

	if len(errors) == 1 {
		return errors[0]
	}

	var errs = make([]string, 0, len(errors))
	for _, err := range errors {
		if err == nil {
			continue
		}
		errs = append(errs, err.Error())
	}

	return fmt.Errorf("%d errors: \n\t%s",
		len(errors),
		strings.Join(errs, "\n\t"))
}
