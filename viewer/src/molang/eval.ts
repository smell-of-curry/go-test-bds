import { evalMath } from "./math";
import type {
  AccessExpr,
  AstNode,
  MolangHost,
  MolangValue,
  StatementList,
} from "./types";
import { MolangError } from "./types";
import { asNumber, isMissing, isTruthy, valuesEqual, wrapIndex } from "./value";

/** Bedrock documents a hard loop cap of 1024. */
export const MAX_LOOP_ITERATIONS = 1024;

class ReturnSignal {
  constructor(readonly value: MolangValue) {}
}
class BreakSignal {}
class ContinueSignal {}

/**
 * Evaluate a compiled AST against a host.
 *
 * @param program - Parsed statement list.
 * @param host - Query / array / variable / RNG bridge.
 * @returns the expression result (`0` for complex programs without `return`).
 * @throws {MolangError} on runaway loops or illegal `break`/`continue`.
 */
export function evaluateAst(
  program: StatementList,
  host: MolangHost,
): MolangValue {
  const temps = new Map<string, MolangValue>();
  const ctx: EvalCtx = { host, temps, loopDepth: 0 };

  try {
    let last: MolangValue = 0;
    for (const stmt of program.body) {
      last = evalNode(stmt, ctx);
    }
    if (program.complex) return 0;
    return last;
  } catch (e) {
    if (e instanceof ReturnSignal) return e.value;
    throw e;
  }
}

interface EvalCtx {
  host: MolangHost;
  temps: Map<string, MolangValue>;
  loopDepth: number;
}

function evalNode(node: AstNode, ctx: EvalCtx): MolangValue {
  switch (node.kind) {
    case "number":
      return node.value;
    case "string":
      return node.value;
    case "unary": {
      const v = evalNode(node.operand, ctx);
      if (node.op === "!") return isTruthy(v) ? 0 : 1;
      return -asNumber(v);
    }
    case "binary":
      return evalBinary(node.op, node.left, node.right, ctx);
    case "ternary": {
      if (!isTruthy(evalNode(node.condition, ctx))) {
        return node.alternate ? evalNode(node.alternate, ctx) : 0;
      }
      return evalNode(node.consequent, ctx);
    }
    case "assign": {
      const value = evalNode(node.value, ctx);
      if (node.scope === "variable") ctx.host.setVariable(node.name, value);
      else ctx.temps.set(node.name, value);
      return value;
    }
    case "access":
      return evalAccess(node, ctx, []);
    case "call": {
      const args = node.args.map((a) => evalNode(a, ctx));
      return evalAccess(node.callee, ctx, args);
    }
    case "index": {
      const target = evalNode(node.target, ctx);
      const idx = asNumber(evalNode(node.index, ctx));
      if (!Array.isArray(target) || target.length === 0) return 0;
      return target[wrapIndex(idx, target.length)] ?? 0;
    }
    case "block": {
      let last: MolangValue = 0;
      for (const stmt of node.body) last = evalNode(stmt, ctx);
      return last;
    }
    case "return":
      throw new ReturnSignal(evalNode(node.value, ctx));
    case "break":
      if (ctx.loopDepth <= 0) {
        throw new MolangError("break outside of loop/for_each", node.pos);
      }
      throw new BreakSignal();
    case "continue":
      if (ctx.loopDepth <= 0) {
        throw new MolangError("continue outside of loop/for_each", node.pos);
      }
      throw new ContinueSignal();
    case "loop": {
      const raw = asNumber(evalNode(node.count, ctx));
      const count = Math.min(Math.max(0, Math.floor(raw)), MAX_LOOP_ITERATIONS);
      if (raw > MAX_LOOP_ITERATIONS) {
        throw new MolangError(
          `loop count ${raw} exceeds max ${MAX_LOOP_ITERATIONS}`,
          node.pos,
        );
      }
      ctx.loopDepth++;
      try {
        for (let i = 0; i < count; i++) {
          try {
            evalNode(node.body, ctx);
          } catch (e) {
            if (e instanceof ContinueSignal) continue;
            if (e instanceof BreakSignal) break;
            throw e;
          }
        }
      } finally {
        ctx.loopDepth--;
      }
      return 0;
    }
    case "for_each": {
      const arrVal = evalNode(node.array, ctx);
      const items = Array.isArray(arrVal) ? arrVal : [];
      if (items.length > MAX_LOOP_ITERATIONS) {
        throw new MolangError(
          `for_each length ${items.length} exceeds max ${MAX_LOOP_ITERATIONS}`,
          node.pos,
        );
      }
      ctx.loopDepth++;
      try {
        for (const item of items) {
          if (node.variable.scope === "variable") {
            ctx.host.setVariable(node.variable.name, item);
          } else {
            ctx.temps.set(node.variable.name, item);
          }
          try {
            evalNode(node.body, ctx);
          } catch (e) {
            if (e instanceof ContinueSignal) continue;
            if (e instanceof BreakSignal) break;
            throw e;
          }
        }
      } finally {
        ctx.loopDepth--;
      }
      return 0;
    }
    case "statements": {
      let last: MolangValue = 0;
      for (const stmt of node.body) last = evalNode(stmt, ctx);
      return node.complex ? 0 : last;
    }
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

function evalBinary(
  op: string,
  leftNode: AstNode,
  rightNode: AstNode,
  ctx: EvalCtx,
): MolangValue {
  if (op === "&&") {
    const left = evalNode(leftNode, ctx);
    return isTruthy(left) ? evalNode(rightNode, ctx) : 0;
  }
  if (op === "||") {
    const left = evalNode(leftNode, ctx);
    return isTruthy(left) ? left : evalNode(rightNode, ctx);
  }
  if (op === "??") {
    const left = evalNode(leftNode, ctx);
    return isMissing(left) ? evalNode(rightNode, ctx) : left;
  }

  const left = evalNode(leftNode, ctx);
  const right = evalNode(rightNode, ctx);

  switch (op) {
    case "+":
      return asNumber(left) + asNumber(right);
    case "-":
      return asNumber(left) - asNumber(right);
    case "*":
      return asNumber(left) * asNumber(right);
    case "/": {
      const d = asNumber(right);
      if (d === 0) return 0;
      return asNumber(left) / d;
    }
    case "<":
      return asNumber(left) < asNumber(right) ? 1 : 0;
    case "<=":
      return asNumber(left) <= asNumber(right) ? 1 : 0;
    case ">":
      return asNumber(left) > asNumber(right) ? 1 : 0;
    case ">=":
      return asNumber(left) >= asNumber(right) ? 1 : 0;
    case "==":
      return valuesEqual(left, right) ? 1 : 0;
    case "!=":
      return valuesEqual(left, right) ? 0 : 1;
    default:
      return 0;
  }
}

function evalAccess(
  node: AccessExpr,
  ctx: EvalCtx,
  args: MolangValue[],
): MolangValue {
  switch (node.scope) {
    case "variable":
      return ctx.host.getVariable(node.name);
    case "temp":
      return ctx.temps.has(node.name) ? ctx.temps.get(node.name)! : null;
    case "context":
      return ctx.host.getContext?.(node.name) ?? null;
    case "query":
      return ctx.host.query(node.name, args);
    case "math":
      return evalMath(node.name, args, ctx.host.random);
    case "geometry":
    case "texture":
    case "material":
      if (ctx.host.resolveResource) {
        return ctx.host.resolveResource(node.scope, node.name);
      }
      return `${node.scope}.${node.name}`;
    case "array": {
      const arr = ctx.host.getArray(node.name);
      return arr ?? null;
    }
  }
}
