import type { MolangValue, RandomSource } from "./types";
import { asNumber } from "./value";

const DEG2RAD = Math.PI / 180;

/**
 * Evaluate a `math.*` call or constant.
 *
 * Trig uses **degrees** per Microsoft Molang docs
 * (`math.sin` / `math.cos` are documented as "Sine/Cosine (in degrees) of value").
 *
 * @param name - Function or constant name (lowercase).
 * @param args - Evaluated arguments.
 * @param random - Injected RNG for random / die_roll helpers.
 * @returns the numeric (or rarely string) result; unknown names yield `0`.
 */
export function evalMath(
  name: string,
  args: MolangValue[],
  random: RandomSource,
): MolangValue {
  const n = (...i: number[]): number[] => i.map((k) => asNumber(args[k]));

  switch (name) {
    case "pi":
      return Math.PI;
    case "abs":
      return Math.abs(n(0)[0]!);
    case "ceil":
      return Math.ceil(n(0)[0]!);
    case "floor":
      return Math.floor(n(0)[0]!);
    case "round":
      return Math.round(n(0)[0]!);
    case "trunc":
      return Math.trunc(n(0)[0]!);
    case "sqrt":
      return Math.sqrt(n(0)[0]!);
    case "exp":
      return Math.exp(n(0)[0]!);
    case "ln":
      return Math.log(n(0)[0]!);
    case "sin":
      return Math.sin(n(0)[0]! * DEG2RAD);
    case "cos":
      return Math.cos(n(0)[0]! * DEG2RAD);
    case "clamp": {
      const [x, lo, hi] = n(0, 1, 2);
      return Math.min(hi!, Math.max(lo!, x!));
    }
    case "max":
      return Math.max(n(0)[0]!, n(1)[0]!);
    case "min":
      return Math.min(n(0)[0]!, n(1)[0]!);
    case "mod": {
      const [a, b] = n(0, 1);
      if (b === 0) return 0;
      return a! % b!;
    }
    case "pow":
      return Math.pow(n(0)[0]!, n(1)[0]!);
    case "hermite_blend": {
      const t = n(0)[0]!;
      return 3 * t * t - 2 * t * t * t;
    }
    case "lerp": {
      const [a, b, t] = n(0, 1, 2);
      return a! + (b! - a!) * t!;
    }
    case "lerprotate": {
      const [start, end, t] = n(0, 1, 2);
      const diff = ((((end! - start!) % 360) + 540) % 360) - 180;
      return start! + diff * t!;
    }
    case "random": {
      const [lo, hi] = n(0, 1);
      return lo! + random.next() * (hi! - lo!);
    }
    case "random_integer": {
      const lo = Math.ceil(n(0)[0]!);
      const hi = Math.floor(n(1)[0]!);
      if (hi < lo) return lo;
      return lo + Math.floor(random.next() * (hi - lo + 1));
    }
    case "die_roll": {
      const count = Math.max(0, Math.floor(n(0)[0]!));
      const [lo, hi] = n(1, 2);
      let sum = 0;
      for (let i = 0; i < count; i++) {
        sum += lo! + random.next() * (hi! - lo!);
      }
      return sum;
    }
    case "die_roll_integer": {
      const count = Math.max(0, Math.floor(n(0)[0]!));
      const lo = Math.ceil(n(1)[0]!);
      const hi = Math.floor(n(2)[0]!);
      let sum = 0;
      for (let i = 0; i < count; i++) {
        sum += hi < lo ? lo : lo + Math.floor(random.next() * (hi - lo + 1));
      }
      return sum;
    }
    default:
      return 0;
  }
}
