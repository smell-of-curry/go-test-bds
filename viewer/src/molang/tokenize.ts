import { MolangError } from "./types";

export type TokenType =
  | "number"
  | "string"
  | "ident"
  | "true"
  | "false"
  | "+"
  | "-"
  | "*"
  | "/"
  | "!"
  | "<"
  | "<="
  | ">"
  | ">="
  | "=="
  | "!="
  | "&&"
  | "||"
  | "??"
  | "?"
  | ":"
  | "="
  | "("
  | ")"
  | "{"
  | "}"
  | "["
  | "]"
  | ","
  | ";"
  | "."
  | "eof";

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const KEYWORDS: Record<string, TokenType> = {
  true: "true",
  false: "false",
  return: "ident",
  loop: "ident",
  for_each: "ident",
  break: "ident",
  continue: "ident",
};

/**
 * Lex a Molang source string into tokens. Identifiers are lowercased;
 * string contents keep their case.
 *
 * @param source - Molang source text.
 * @returns the token stream including a trailing `eof`.
 * @throws {MolangError} on an illegal character or unterminated string.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const push = (type: TokenType, value: string, pos: number): void => {
    tokens.push({ type, value, pos });
  };

  while (i < source.length) {
    const c = source[i]!;
    const pos = i;

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }

    if (c >= "0" && c <= "9") {
      let j = i + 1;
      while (j < source.length && /[0-9.]/.test(source[j]!)) j++;
      const raw = source.slice(i, j);
      if (raw.split(".").length > 2) {
        throw new MolangError(`invalid number '${raw}'`, pos);
      }
      push("number", raw, pos);
      i = j;
      continue;
    }

    if (c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== "'") j++;
      if (j >= source.length) {
        throw new MolangError("unterminated string", pos);
      }
      push("string", source.slice(i + 1, j), pos);
      i = j + 1;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j++;
      const raw = source.slice(i, j).toLowerCase();
      const kw = KEYWORDS[raw];
      if (kw === "true" || kw === "false") push(kw, raw, pos);
      else push("ident", raw, pos);
      i = j;
      continue;
    }

    const two = source.slice(i, i + 2);
    if (
      two === "<=" ||
      two === ">=" ||
      two === "==" ||
      two === "!=" ||
      two === "&&" ||
      two === "||" ||
      two === "??"
    ) {
      push(two, two, pos);
      i += 2;
      continue;
    }

    switch (c) {
      case "+":
      case "-":
      case "*":
      case "/":
      case "!":
      case "<":
      case ">":
      case "?":
      case ":":
      case "=":
      case "(":
      case ")":
      case "{":
      case "}":
      case "[":
      case "]":
      case ",":
      case ";":
      case ".":
        push(c, c, pos);
        i++;
        continue;
      default:
        throw new MolangError(`unexpected character '${c}'`, pos);
    }
  }

  push("eof", "", i);
  return tokens;
}
