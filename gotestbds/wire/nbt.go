package wire

import "strconv"

func asMap(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

func mapString(m map[string]any, key string) (string, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return "", false
	}
	switch t := v.(type) {
	case string:
		return t, true
	default:
		return "", false
	}
}

func mapBool(m map[string]any, key string) (bool, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return false, false
	}
	b, ok := v.(bool)
	return b, ok
}

func mapInt32(m map[string]any, key string) (int32, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return 0, false
	}
	switch t := v.(type) {
	case int32:
		return t, true
	case int64:
		return int32(t), true
	case int:
		return int32(t), true
	case float32:
		return int32(t), true
	case float64:
		return int32(t), true
	case string:
		n, err := strconv.ParseInt(t, 10, 32)
		if err != nil {
			return 0, false
		}
		return int32(n), true
	default:
		return 0, false
	}
}

func mapFloat32(m map[string]any, key string) (float32, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return 0, false
	}
	switch t := v.(type) {
	case float32:
		return t, true
	case float64:
		return float32(t), true
	case int32:
		return float32(t), true
	case int64:
		return float32(t), true
	case int:
		return float32(t), true
	default:
		return 0, false
	}
}

func mapSlice(m map[string]any, key string) ([]any, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return nil, false
	}
	switch t := v.(type) {
	case []any:
		return t, true
	case []map[string]any:
		out := make([]any, len(t))
		for i := range t {
			out[i] = t[i]
		}
		return out, true
	default:
		return nil, false
	}
}
