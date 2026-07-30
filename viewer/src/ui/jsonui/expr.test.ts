import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evalExpr, parseExpr, type ExprScope } from "./expr.js";

function scope(opts: {
  bindings?: Record<string, string | number | boolean>;
  vars?: Record<string, unknown>;
}): ExprScope {
  return {
    binding: (n) => opts.bindings?.[n],
    variable: (n) => opts.vars?.[n],
  };
}

function ev(src: string, s: ExprScope = scope({})): string | number | boolean {
  return evalExpr(parseExpr(src), s);
}

describe("parseExpr / evalExpr operators", () => {
  it("numbers and arithmetic", () => {
    assert.equal(ev("1 + 2"), 3);
    assert.equal(ev("10 - 3"), 7);
    assert.equal(ev("4 * 5"), 20);
    assert.equal(ev("8 / 2"), 4);
  });

  it("precedence: * / before + -", () => {
    assert.equal(ev("1 + 2 * 3"), 7);
    assert.equal(ev("(1 + 2) * 3"), 9);
    assert.equal(ev("10 - 4 / 2"), 8);
  });

  it("comparisons", () => {
    assert.equal(ev("3 > 1"), true);
    assert.equal(ev("3 < 1"), false);
    assert.equal(ev("3 >= 3"), true);
    assert.equal(ev("2 <= 1"), false);
    assert.equal(ev("2 = 2"), true);
  });

  it("and / or / not", () => {
    assert.equal(ev("(1 = 1) and (2 = 2)"), true);
    assert.equal(ev("(1 = 0) or (2 = 2)"), true);
    assert.equal(ev("not (1 = 0)"), true);
    assert.equal(ev("not (1 = 1)"), false);
  });

  it("string concat with +", () => {
    assert.equal(ev("('ab' + 'cd')"), "abcd");
    assert.equal(
      ev("('hello' + #x)", scope({ bindings: { x: "!" } })),
      "hello!",
    );
  });

  it("('%.Ns' * str) truncates", () => {
    assert.equal(ev("('%.4s' * 'abcdef')"), "abcd");
    assert.equal(ev("(%.2s * #t)", scope({ bindings: { t: "XYZZ" } })), "XY");
  });

  it("(str - substr) removes", () => {
    assert.equal(ev("('foobar' - 'oba')"), "for");
    assert.equal(ev("(#s - '|')", scope({ bindings: { s: "abc|" } })), "abc");
  });

  it("composed format ('%.' + $n + 's')", () => {
    assert.equal(
      ev(
        "(('%.' + $n + 's') * #t)",
        scope({ bindings: { t: "HELLO" }, vars: { n: 3 } }),
      ),
      "HEL",
    );
  });

  it("(str * 1) parses integer", () => {
    assert.equal(ev("('0042' * 1)"), 42);
    assert.equal(
      ev(
        "((#field * 1) * $percent_to_ratio)",
        scope({
          bindings: { field: "75" },
          vars: { percent_to_ratio: 0.01 },
        }),
      ),
      0.75,
    );
  });

  it("string equality", () => {
    assert.equal(ev("(#a = 'null')", scope({ bindings: { a: "null" } })), true);
    assert.equal(ev("(#a = 'null')", scope({ bindings: { a: "x" } })), false);
    assert.equal(ev("(#a = '')", scope({ bindings: { a: "" } })), true);
  });

  it("unary minus", () => {
    assert.equal(ev("-3 + 5"), 2);
  });
});

describe("sidebar field extraction (real $string_parser)", () => {
  // From pokebedrock-res ui/_global_variables.json + sidebar.json $var_size: 121
  const STRING_PARSER =
    "((('%.' + $var_size + 's') * (#string - (('%.' + ($var_size * $var_index) + 's') * #string))) - '|')";

  function pad120(s: string): string {
    return s.padEnd(120, " ").slice(0, 120);
  }

  it("extracts field 1 from a 2-field &_sidebar payload", () => {
    const field0 = pad120("Lv5 20/20");
    const field1 = pad120("Pikachu");
    // BEH packs 120-char fields joined with `|`; stride = 121 (= field + pipe).
    const packed = `${field0}|${field1}`;
    const title = `&_sidebar:${packed}`;

    // Elements bind #string from the sidebar slice (after `&_sidebar:`).
    // Here we feed the packed body directly as #string, matching variable_parser.
    const got = ev(
      STRING_PARSER,
      scope({
        bindings: { string: packed },
        vars: { var_size: 121, var_index: 1 },
      }),
    );
    assert.equal(got, field1);

    const got0 = ev(
      STRING_PARSER,
      scope({
        bindings: { string: packed },
        vars: { var_size: 121, var_index: 0 },
      }),
    );
    assert.equal(got0, field0);

    // Title-prefix suppress idiom from hud_screen.json
    assert.equal(
      ev(
        "(%.2s * #hud_title_text_string)",
        scope({
          bindings: { hud_title_text_string: title },
        }),
      ),
      "&_",
    );
  });
});
