import { tokenize, type Token, type TokenType } from "./tokenize";
import {
  MolangError,
  type AccessExpr,
  type AssignTarget,
  type AstNode,
  type BinaryOp,
  type StatementList,
} from "./types";

/** Binding powers — higher binds tighter. */
const enum Bp {
  None = 0,
  Assign = 1,
  NullCoalesce = 2,
  Ternary = 3,
  Or = 4,
  And = 5,
  Equality = 6,
  Compare = 7,
  Sum = 8,
  Product = 9,
  Prefix = 10,
  Postfix = 11,
}

/**
 * Parse Molang source into an AST.
 *
 * @param source - Molang source text.
 * @returns a statement-list root node.
 * @throws {MolangError} on syntax errors (message includes position).
 */
export function parse(source: string): StatementList {
  return new Parser(tokenize(source)).parseProgram();
}

class Parser {
  private i = 0;

  constructor(private readonly tokens: Token[]) {}

  parseProgram(): StatementList {
    const pos = this.peek().pos;
    const body: AstNode[] = [];
    let complex = false;

    if (this.peek().type === "eof") {
      return {
        kind: "statements",
        body: [{ kind: "number", value: 0, pos }],
        complex: false,
        pos,
      };
    }

    while (!this.check("eof")) {
      body.push(this.parseStatement());
      if (this.match(";")) {
        complex = true;
        while (this.match(";")) {
          /* empty statements */
        }
        if (this.check("eof")) break;
        continue;
      }
      break;
    }

    if (!this.check("eof")) {
      // More statements without a prior `;` — still statement mode.
      complex = true;
      while (!this.check("eof")) {
        body.push(this.parseStatement());
        if (!this.match(";")) {
          if (!this.check("eof")) {
            throw new MolangError(
              `expected ';' or end of input, found '${this.peek().value}'`,
              this.peek().pos,
            );
          }
          break;
        }
        while (this.match(";")) {
          /* empty */
        }
      }
    }

    if (body.length > 1) complex = true;

    return { kind: "statements", body, complex, pos };
  }

  private parseStatement(): AstNode {
    const t = this.peek();
    if (t.type === "ident" && t.value === "return") {
      this.advance();
      const value = this.parseExpression(Bp.None);
      return { kind: "return", value, pos: t.pos };
    }
    if (t.type === "ident" && t.value === "break") {
      this.advance();
      return { kind: "break", pos: t.pos };
    }
    if (t.type === "ident" && t.value === "continue") {
      this.advance();
      return { kind: "continue", pos: t.pos };
    }
    return this.parseExpression(Bp.None);
  }

  private parseExpression(minBp: number): AstNode {
    let left = this.parsePrefix();

    for (;;) {
      const op = this.peek();

      if (op.type === "(" && this.isCallable(left)) {
        if (Bp.Postfix < minBp) break;
        left = this.parseCall(left as AccessExpr);
        continue;
      }

      if (op.type === "[") {
        if (Bp.Postfix < minBp) break;
        const pos = this.advance().pos;
        const index = this.parseExpression(Bp.None);
        this.expect("]");
        left = { kind: "index", target: left, index, pos };
        continue;
      }

      if (op.type === "=" && this.isAssignTarget(left)) {
        if (Bp.Assign < minBp) break;
        const pos = this.advance().pos;
        const value = this.parseExpression(Bp.Assign);
        const target = left as AccessExpr;
        left = {
          kind: "assign",
          scope: target.scope as "variable" | "temp",
          name: target.name,
          value,
          pos,
        };
        continue;
      }

      if (op.type === "?") {
        if (Bp.Ternary < minBp) break;
        const pos = this.advance().pos;
        const consequent = this.parseExpression(Bp.Ternary);
        let alternate: AstNode | null = null;
        if (this.match(":")) {
          alternate = this.parseExpression(Bp.Ternary);
        }
        left = { kind: "ternary", condition: left, consequent, alternate, pos };
        continue;
      }

      const bin = this.binaryBp(op.type);
      if (bin === null) break;
      const [lBp, rBp] = bin;
      if (lBp < minBp) break;
      const pos = this.advance().pos;
      const right = this.parseExpression(rBp);
      left = {
        kind: "binary",
        op: op.type as BinaryOp,
        left,
        right,
        pos,
      };
    }

    return left;
  }

  private parsePrefix(): AstNode {
    const t = this.peek();

    if (t.type === "number") {
      this.advance();
      return { kind: "number", value: Number(t.value), pos: t.pos };
    }
    if (t.type === "string") {
      this.advance();
      return { kind: "string", value: t.value, pos: t.pos };
    }
    if (t.type === "true") {
      this.advance();
      return { kind: "number", value: 1, pos: t.pos };
    }
    if (t.type === "false") {
      this.advance();
      return { kind: "number", value: 0, pos: t.pos };
    }
    if (t.type === "!" || t.type === "-") {
      this.advance();
      const operand = this.parseExpression(Bp.Prefix);
      return { kind: "unary", op: t.type, operand, pos: t.pos };
    }
    if (t.type === "(") {
      this.advance();
      const expr = this.parseExpression(Bp.None);
      this.expect(")");
      return expr;
    }
    if (t.type === "{") {
      return this.parseBlock();
    }
    if (t.type === "ident") {
      if (t.value === "loop") return this.parseLoop();
      if (t.value === "for_each") return this.parseForEach();
      return this.parseAccess();
    }

    throw new MolangError(`unexpected token '${t.value || t.type}'`, t.pos);
  }

  private parseBlock(): AstNode {
    const pos = this.expect("{").pos;
    const body: AstNode[] = [];
    while (!this.check("}") && !this.check("eof")) {
      body.push(this.parseStatement());
      if (!this.match(";")) {
        // Allow a final statement without trailing semicolon.
        if (!this.check("}")) {
          throw new MolangError(
            `expected ';' inside block, found '${this.peek().value}'`,
            this.peek().pos,
          );
        }
        break;
      }
      while (this.match(";")) {
        /* empty */
      }
    }
    this.expect("}");
    return { kind: "block", body, pos };
  }

  private parseLoop(): AstNode {
    const pos = this.expectIdent("loop").pos;
    this.expect("(");
    const count = this.parseExpression(Bp.None);
    this.expect(",");
    const body = this.parseExpression(Bp.None);
    this.expect(")");
    return { kind: "loop", count, body, pos };
  }

  private parseForEach(): AstNode {
    const pos = this.expectIdent("for_each").pos;
    this.expect("(");
    const variable = this.parseAssignTarget();
    this.expect(",");
    const array = this.parseExpression(Bp.None);
    this.expect(",");
    const body = this.parseExpression(Bp.None);
    this.expect(")");
    return { kind: "for_each", variable, array, body, pos };
  }

  private parseAssignTarget(): AssignTarget {
    const access = this.parseAccess();
    if (access.scope !== "variable" && access.scope !== "temp") {
      throw new MolangError(
        "for_each variable must be variable.* or temp.*",
        access.pos,
      );
    }
    return { scope: access.scope, name: access.name, pos: access.pos };
  }

  private parseAccess(): AccessExpr {
    const first = this.expect("ident");
    const scopeAlias = resolveScope(first.value);
    if (scopeAlias && this.match(".")) {
      const nameTok = this.expect("ident");
      return {
        kind: "access",
        scope: scopeAlias,
        name: nameTok.value,
        pos: first.pos,
      };
    }
    // Bare identifier — treat as temp-less error? Molang reserves them.
    // Allow as math-less bare name → access under a fake scope that eval rejects.
    throw new MolangError(
      `unknown identifier '${first.value}' (expected scoped name like v.x or query.foo)`,
      first.pos,
    );
  }

  private parseCall(callee: AccessExpr): AstNode {
    const pos = this.expect("(").pos;
    const args: AstNode[] = [];
    if (!this.check(")")) {
      do {
        args.push(this.parseExpression(Bp.None));
      } while (this.match(","));
    }
    this.expect(")");
    return { kind: "call", callee, args, pos };
  }

  private binaryBp(type: TokenType): [number, number] | null {
    switch (type) {
      case "??":
        return [Bp.NullCoalesce, Bp.NullCoalesce + 1];
      case "||":
        return [Bp.Or, Bp.Or + 1];
      case "&&":
        return [Bp.And, Bp.And + 1];
      case "==":
      case "!=":
        return [Bp.Equality, Bp.Equality + 1];
      case "<":
      case "<=":
      case ">":
      case ">=":
        return [Bp.Compare, Bp.Compare + 1];
      case "+":
      case "-":
        return [Bp.Sum, Bp.Sum + 1];
      case "*":
      case "/":
        return [Bp.Product, Bp.Product + 1];
      default:
        return null;
    }
  }

  private isCallable(node: AstNode): boolean {
    return (
      node.kind === "access" &&
      (node.scope === "query" ||
        node.scope === "math" ||
        node.scope === "geometry" ||
        node.scope === "texture" ||
        node.scope === "material")
    );
  }

  private isAssignTarget(node: AstNode): boolean {
    return (
      node.kind === "access" &&
      (node.scope === "variable" || node.scope === "temp")
    );
  }

  private peek(): Token {
    return this.tokens[this.i]!;
  }

  private advance(): Token {
    return this.tokens[this.i++]!;
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private match(type: TokenType): boolean {
    if (!this.check(type)) return false;
    this.advance();
    return true;
  }

  private expect(type: TokenType): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new MolangError(
        `expected '${type}', found '${t.value || t.type}'`,
        t.pos,
      );
    }
    return this.advance();
  }

  private expectIdent(value: string): Token {
    const t = this.peek();
    if (t.type !== "ident" || t.value !== value) {
      throw new MolangError(`expected '${value}', found '${t.value}'`, t.pos);
    }
    return this.advance();
  }
}

function resolveScope(name: string): AccessExpr["scope"] | null {
  switch (name) {
    case "variable":
    case "v":
      return "variable";
    case "temp":
    case "t":
      return "temp";
    case "context":
    case "c":
      return "context";
    case "query":
    case "q":
      return "query";
    case "math":
      return "math";
    case "geometry":
      return "geometry";
    case "texture":
      return "texture";
    case "material":
      return "material";
    case "array":
      return "array";
    default:
      return null;
  }
}
