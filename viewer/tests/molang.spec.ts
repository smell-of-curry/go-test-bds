import { expect, test } from "@playwright/test";
import {
  clearCompileCache,
  compile,
  createDefaultHost,
  evaluate,
  MAX_LOOP_ITERATIONS,
  MolangError,
  sequenceRandom,
} from "../src/molang";

function num(source: string, host = createDefaultHost()): number {
  const v = evaluate(source, host);
  expect(typeof v).toBe("number");
  return v as number;
}

test.describe("molang operators", () => {
  test("arithmetic precedence: * before +", () => {
    expect(num("1 + 2 * 3")).toBe(7);
    expect(num("(1 + 2) * 3")).toBe(9);
  });

  test("unary minus and logical not", () => {
    expect(num("-3 + 5")).toBe(2);
    expect(num("!0")).toBe(1);
    expect(num("!1")).toBe(0);
    expect(num("!!5")).toBe(1);
  });

  test("comparison and equality bind correctly vs && / ||", () => {
    // (1 < 2) == (3 > 0) → 1; && before ||
    expect(num("1 < 2 == 3 > 0")).toBe(1);
    expect(num("0 && 1 || 1")).toBe(1);
    expect(num("0 && (1 || 1)")).toBe(0);
  });

  test("ternary is right-associative", () => {
    // A ? B : C ? D : E  →  A ? B : (C ? D : E)
    expect(num("0 ? 1 : 0 ? 2 : 3")).toBe(3);
    expect(num("0 ? 1 : 1 ? 2 : 3")).toBe(2);
    expect(num("1 ? 1 ? 8 : 9 : 3")).toBe(8);
  });

  test("null coalescing is below ternary and fills missing vars", () => {
    const host = createDefaultHost({ variables: { a: 7 } });
    expect(num("variable.missing ?? 5", host)).toBe(5);
    expect(num("variable.a ?? 5", host)).toBe(7);
    expect(num("0 ? variable.missing : variable.missing ?? 4", host)).toBe(4);
  });

  test("true / false / strings", () => {
    expect(num("true")).toBe(1);
    expect(num("false")).toBe(0);
    expect(evaluate("'pig' == 'pig'")).toBe(1);
    expect(evaluate("'pig' != 'cow'")).toBe(1);
  });
});

test.describe("molang math.*", () => {
  test("trig uses degrees — math.sin(90) == 1", () => {
    expect(num("math.sin(90)")).toBeCloseTo(1, 10);
    expect(num("math.cos(0)")).toBeCloseTo(1, 10);
    expect(num("math.cos(90)")).toBeCloseTo(0, 10);
  });

  test("every listed math helper against hand values", () => {
    expect(num("math.abs(-3)")).toBe(3);
    expect(num("math.ceil(1.2)")).toBe(2);
    expect(num("math.floor(1.8)")).toBe(1);
    expect(num("math.round(1.5)")).toBe(2);
    expect(num("math.trunc(-1.8)")).toBe(-1);
    expect(num("math.clamp(5, 0, 3)")).toBe(3);
    expect(num("math.clamp(-1, 0, 3)")).toBe(0);
    expect(num("math.exp(0)")).toBeCloseTo(1, 10);
    expect(num("math.ln(math.exp(2))")).toBeCloseTo(2, 10);
    expect(num("math.max(2, 9)")).toBe(9);
    expect(num("math.min(2, 9)")).toBe(2);
    expect(num("math.mod(7, 4)")).toBe(3);
    expect(num("math.pow(2, 3)")).toBe(8);
    expect(num("math.sqrt(9)")).toBe(3);
    expect(num("math.pi")).toBeCloseTo(Math.PI, 10);
    expect(num("math.hermite_blend(0)")).toBe(0);
    expect(num("math.hermite_blend(1)")).toBe(1);
    expect(num("math.hermite_blend(0.5)")).toBeCloseTo(0.5, 10);
    expect(num("math.lerp(0, 10, 0.25)")).toBeCloseTo(2.5, 10);
    // Shortest arc 350→10 is +20°; halfway lands on 360 (unnormalized).
    expect(num("math.lerprotate(350, 10, 0.5)")).toBeCloseTo(360, 10);
  });

  test("injected random is deterministic", () => {
    const host = createDefaultHost({ random: sequenceRandom([0, 0.5, 1]) });
    // random(low,high) = low + next*(high-low); next=0 → low
    expect(num("math.random(10, 20)", host)).toBe(10);
    expect(num("math.random(10, 20)", host)).toBe(15);
    // random_integer: next=1 → may clamp; with next cycling
    const h2 = createDefaultHost({ random: sequenceRandom([0]) });
    expect(num("math.random_integer(3, 5)", h2)).toBe(3);
    const h3 = createDefaultHost({ random: sequenceRandom([0.999]) });
    expect(num("math.random_integer(3, 5)", h3)).toBe(5);
    const h4 = createDefaultHost({ random: sequenceRandom([0.5, 0.5]) });
    expect(num("math.die_roll(2, 0, 10)", h4)).toBe(10);
    const h5 = createDefaultHost({ random: sequenceRandom([0]) });
    expect(num("math.die_roll_integer(3, 1, 1)", h5)).toBe(3);
  });
});

test.describe("molang variables", () => {
  test("variable persists across evaluations; temp does not", () => {
    const host = createDefaultHost();
    expect(num("v.score = 10", host)).toBe(10);
    expect(num("v.score + 1", host)).toBe(11);

    expect(num("t.x = 5; return t.x;", host)).toBe(5);
    // fresh temp scope on next evaluate
    expect(num("t.x ?? 0", host)).toBe(0);
    expect(num("v.score", host)).toBe(10);
  });

  test("aliases v/t/q/c", () => {
    const host = createDefaultHost({
      queries: { life_time: 2 },
      context: { is_first_person: 1 },
    });
    expect(
      num("v.a = q.life_time; return v.a + c.is_first_person;", host),
    ).toBe(3);
  });
});

test.describe("molang control flow", () => {
  test("conditional statement blocks", () => {
    const host = createDefaultHost();
    expect(num("v.x = 0; 1 ? { v.x = 4; }; return v.x;", host)).toBe(4);
    expect(
      num("v.x = 0; 0 ? { v.x = 4; } : { v.x = 9; }; return v.x;", host),
    ).toBe(9);
  });

  test("loop, break, continue, return", () => {
    const host = createDefaultHost();
    expect(
      num(
        `v.x = 0;
         loop(5, { v.x = v.x + 1; });
         return v.x;`,
        host,
      ),
    ).toBe(5);

    expect(
      num(
        `v.x = 0;
         loop(10, {
           v.x = v.x + 1;
           (v.x == 3) ? { break; };
         });
         return v.x;`,
        host,
      ),
    ).toBe(3);

    expect(
      num(
        `v.x = 0;
         v.y = 0;
         loop(5, {
           v.x = v.x + 1;
           (v.x == 2) ? { continue; };
           v.y = v.y + 1;
         });
         return v.y;`,
        host,
      ),
    ).toBe(4);

    expect(
      num(
        `loop(3, { return 42; });
         return 0;`,
        host,
      ),
    ).toBe(42);
  });

  test("for_each over host array", () => {
    const host = createDefaultHost({
      arrays: { things: [1, 2, 3, 4] },
    });
    expect(
      num(
        `v.sum = 0;
         for_each(t.item, array.things, {
           v.sum = v.sum + t.item;
         });
         return v.sum;`,
        host,
      ),
    ).toBe(10);
  });

  test("runaway loop is rejected", () => {
    expect(() =>
      evaluate(`loop(${MAX_LOOP_ITERATIONS + 1}, { v.x = 1; })`),
    ).toThrow(MolangError);
  });
});

test.describe("molang arrays", () => {
  test("index wrap: max(0, trunc(i)) % length", () => {
    const host = createDefaultHost({
      arrays: { skins: ["a", "b", "c"] },
    });
    expect(evaluate("array.skins[0]", host)).toBe("a");
    expect(evaluate("array.skins[2]", host)).toBe("c");
    expect(evaluate("array.skins[3]", host)).toBe("a");
    expect(evaluate("array.skins[5]", host)).toBe("c");
    expect(evaluate("array.skins[-1]", host)).toBe("a");
    expect(evaluate("array.skins[1.9]", host)).toBe("b");
  });
});

test.describe("molang host / queries", () => {
  test("unknown queries return 0 and are recorded", () => {
    const host = createDefaultHost();
    expect(num("query.is_baby", host)).toBe(0);
    expect(num("q.has_target('x')", host)).toBe(0);
    expect(host.unimplementedQueries).toEqual(["is_baby", "has_target(1)"]);
  });

  test("known queries resolve through host", () => {
    const host = createDefaultHost({
      queries: {
        variant: 3,
        property: (args) => (args[0] === "pokeb:skin" ? 2 : 0),
      },
    });
    expect(num("query.variant", host)).toBe(3);
    expect(num("query.property('pokeb:skin')", host)).toBe(2);
    expect(host.unimplementedQueries).toEqual([]);
  });
});

test.describe("molang compile cache and errors", () => {
  test("compile caches by source string", () => {
    clearCompileCache();
    const a = compile("1 + 2");
    const b = compile("1 + 2");
    expect(a).toBe(b);
    expect(a.evaluate(createDefaultHost())).toBe(3);
  });

  test("malformed input names position", () => {
    let err: unknown;
    try {
      evaluate("1 +");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MolangError);
    expect((err as MolangError).message).toMatch(/position/);
    expect(typeof (err as MolangError).position).toBe("number");

    let err2: unknown;
    try {
      evaluate("@@@");
    } catch (e) {
      err2 = e;
    }
    expect(err2).toBeInstanceOf(MolangError);
    expect((err2 as MolangError).position).toBe(0);
    expect((err2 as MolangError).message).toMatch(/position 0/);
  });

  test("geometry / texture / material names resolve as strings", () => {
    expect(evaluate("geometry.default")).toBe("geometry.default");
    expect(evaluate("texture.default")).toBe("texture.default");
    expect(evaluate("material.default")).toBe("material.default");
  });
});
