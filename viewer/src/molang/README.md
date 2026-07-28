# Molang interpreter

Self-contained evaluator for Bedrock Molang expressions used by render
controllers, animations and animation controllers. No DOM, no three.js, no
network — just parse → AST → evaluate.

## Public API

```ts
import {
  compile,
  evaluate,
  createDefaultHost,
  sequenceRandom,
  MolangError,
} from "./molang";

const program = compile("math.sin(query.anim_time * 90)");
const host = createDefaultHost({
  queries: { anim_time: 1 },
  random: sequenceRandom([0.25, 0.75]),
});
program.evaluate(host); // → number | string | array | null
```

- `compile(source)` — parse once (cached by source string); call `.evaluate(host)` many times.
- `evaluate(source, host?)` — convenience wrapper.
- `createDefaultHost(options)` — variables, arrays, query map, injectable RNG; unknown queries return `0` and are appended to `unimplementedQueries`.

## Implemented

| Area | Coverage |
| --- | --- |
| Literals | numbers, `'strings'`, `true` / `false` (as `1` / `0`) |
| Arithmetic | `+ - * /`, unary `-` |
| Comparison | `< <= > >= == !=` |
| Logical | `&& \|\| !` (short-circuit; `&&` binds tighter than `\|\|`) |
| Ternary | `A ? B : C` (right-associative) and `A ? B` |
| Statement form | `cond ? { … }` / `cond ? { … } : { … }` |
| Null coalesce | `??` (missing/`null` left → right) |
| Statements | `;`-separated lists, `return`, blocks `{ … }` |
| Scopes | `variable`/`v`, `temp`/`t`, `context`/`c`, `query`/`q`, `math`, `geometry`, `texture`, `material`, `array` |
| Assignment | `variable.*` and `temp.*` only |
| `math.*` | `abs ceil clamp cos die_roll die_roll_integer exp floor hermite_blend lerp lerprotate ln max min mod pi pow random random_integer round sin sqrt trunc` — **degrees** for `sin`/`cos` |
| Loops | `loop(n, {…})`, `for_each(v.x, array, {…})`, `break`, `continue` (cap `1024`) |
| Arrays | `array.name[expr]` with Bedrock wrap: `max(0, trunc(i)) % length` |

Case-insensitive identifiers (strings keep case). Complex programs (any `;`) evaluate to `0` unless they `return`.

## Deliberately not implemented

- Arrow operator `->` (cross-entity access)
- `this`
- Struct member access (`v.color.r`)
- Experimental query surface beyond what the host supplies
- Versioned-change switches keyed on pack `min_engine_version` (behaviour matches modern rules: ternary right-assoc, `&&` before `||`)
- `math.acos` / `asin` / `atan` / `atan2` / `min_angle` (not in the required set)

## What the host must provide

| Hook | Role |
| --- | --- |
| `query(name, args)` | Entity / animation state. Default: `0` + record name. |
| `getArray(name)` | Resource-pack `array.*` tables (textures, geometries, …). |
| `getVariable` / `setVariable` | Persistent per-entity `variable.*` / `v.*`. |
| `random.next()` | Unit float for `math.random*` / `die_roll*`. **Must be injectable** — never `Math.random()`. |
| `getContext?` | Optional `context.*` / `c.*`. |
| `resolveResource?` | Optional `geometry.` / `texture.` / `material.` (default: `"kind.name"` string). |

`temp.*` lives only for one `.evaluate()` call and is cleared automatically.

## Spec sources

- Trig degrees: [Microsoft Learn — math.sin](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/molangreference/examples/molangconcepts/mathfunctions/math_sin), bedrock.dev Molang docs.
- Array index wrap: [Molang Syntax Guide](https://learn.microsoft.com/en-us/minecraft/creator/documents/molang/syntax-guide) and bedrock.dev Array Expressions (`index = max(0, expression_result) % array_size`).
- Loop cap 1024: bedrock.dev `loop` section.
