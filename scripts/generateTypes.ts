// This will read the instructions from @gotestbds/instruction and generate TypeScript types.
// Output is written to scripts/__generated__/types.ts

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

type GoStructField = {
  name: string | null; // null => embedded field
  type: string;
  jsonTag?: string;
  doc?: string;
};

type GoStruct = {
  name: string;
  fields: GoStructField[];
  doc?: string;
};

type InstructionInfo = {
  typeName: string;
  action: string; // value returned by Name()
};

const ROOT = path.resolve(__dirname, "..");
const INSTRUCTION_DIR = path.resolve(ROOT, "gotestbds", "instruction");
const GENERATED_DIR = path.resolve(__dirname, "__generated__");
const GENERATED_FILE = path.join(GENERATED_DIR, "types.ts");

/**
 * Lists all Go files in a directory.
 * @param dir
 * @returns
 */
function listGoFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".go"))
    .map((f) => path.join(dir, f));
}

/**
 * Parses Go structs from a string.
 * @param content
 * @returns
 */
function parseGoStructs(content: string): GoStruct[] {
  const structs: GoStruct[] = [];
  // Capture optional leading doc comments (//... or /* ... */) immediately before the type decl
  const structRegex =
    /(?:\n|^)((?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*\n)*)\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\s*\{([\s\S]*?)\}/g;
  let match: RegExpExecArray | null;
  while ((match = structRegex.exec(content))) {
    const [, leadingDocsRaw, name, body] = match;
    const fields: GoStructField[] = [];
    const lines = body.split(/\r?\n/);
    let pendingDoc: string[] = [];
    let inBlockDoc = false;
    let blockDocBuf: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      // Handle block comments spanning lines within struct body
      if (inBlockDoc) {
        const endIdx = line.indexOf("*/");
        if (endIdx !== -1) {
          blockDocBuf.push(line.slice(0, endIdx));
          pendingDoc.push(...blockDocBuf.map((s) => s.trim()));
          inBlockDoc = false;
          blockDocBuf = [];
        } else {
          blockDocBuf.push(line);
        }
        continue;
      }
      if (line.startsWith("/*")) {
        inBlockDoc = true;
        const afterStart = line.slice(2);
        const endIdx = afterStart.indexOf("*/");
        if (endIdx !== -1) {
          const inner = afterStart.slice(0, endIdx);
          pendingDoc.push(inner.trim());
          inBlockDoc = false;
        } else {
          blockDocBuf = [afterStart];
        }
        continue;
      }
      if (line.startsWith("//")) {
        pendingDoc.push(line.replace(/^\/\//, "").trim());
        continue;
      }
      // Capture trailing inline comment as doc, before we strip it
      const inlineDocMatch = /^(.*?)(?:\s*\/\/\s*(.*))?$/.exec(line);
      const before = inlineDocMatch?.[1] ?? line;
      const trailingDoc = inlineDocMatch?.[2]?.trim();
      // Handle trailing comments and struct closing
      const cleaned = before.replace(/\s*\/\/.*$/, "").replace(/,$/, "");
      if (!cleaned) continue;

      // Match with explicit name:  FieldName Type `json:"..."`
      let m =
        /^(\*?[A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_\*\.\[\]]+)(?:\s+`[^`]*json:"([^"]+)"[^`]*`)?/.exec(
          cleaned,
        );
      if (m) {
        const [, fieldName, fieldType, jsonTag] = m;
        const doc = [...pendingDoc, ...(trailingDoc ? [trailingDoc] : [])]
          .join(" ")
          .trim();
        fields.push({
          name: fieldName,
          type: fieldType,
          jsonTag,
          doc: doc || undefined,
        });
        pendingDoc = [];
        continue;
      }

      // Embedded field: e.g., movement.Input or *movement.Input
      m =
        /^(\*?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)(?:\s+`[^`]*json:"([^"]+)"[^`]*`)?/.exec(
          cleaned,
        );
      if (m) {
        const [, fieldType, jsonTag] = m;
        const doc = [...pendingDoc, ...(trailingDoc ? [trailingDoc] : [])]
          .join(" ")
          .trim();
        fields.push({
          name: null,
          type: fieldType,
          jsonTag,
          doc: doc || undefined,
        });
        pendingDoc = [];
        continue;
      }
    }
    const structDoc = (leadingDocsRaw || "")
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*\/\//, "").trim())
      .filter((l) => l.length > 0)
      .join(" ")
      .trim();
    structs.push({ name, fields, doc: structDoc || undefined });
  }
  return structs;
}

/**
 * Parses instruction actions from a string.
 * @param content
 * @returns
 */
function parseInstructionActions(content: string): InstructionInfo[] {
  const infos: InstructionInfo[] = [];
  // Matches: func (*TypeName) Name() string { return "action" }
  const nameMethodRegex =
    /func\s*\(\s*\*?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*Name\s*\(\s*\)\s*string\s*\{[\s\S]*?return\s+"([^"]+)"[\s\S]*?\}/g;
  let match: RegExpExecArray | null;
  while ((match = nameMethodRegex.exec(content))) {
    const [, typeName, action] = match;
    infos.push({ typeName, action });
  }
  return infos;
}

/**
 * Converts a Go primitive type to a TypeScript type.
 * @param goType
 * @returns
 */
function goPrimitiveToTs(goType: string): string | null {
  const t = goType.replace(/^\*+/, "");
  switch (t) {
    case "string":
      return "string";
    case "bool":
      return "boolean";
    case "int":
    case "int8":
    case "int16":
    case "int32":
    case "int64":
    case "uint":
    case "uint8":
    case "uint16":
    case "uint32":
    case "uint64":
    case "float32":
    case "float64":
      return "number";
    case "any":
      return "any";
  }
  return null;
}

/**
 * Maps an external Go type to a TypeScript type.
 * @param goType
 * @returns
 */
function mapExternalGoTypeToTs(goType: string): string | null {
  const t = goType.replace(/^\*+/, "");
  if (t === "cube.Pos") return "Pos";
  if (t === "cube.Rotation") return "Rotation";
  if (t === "cube.Face") return "Face";
  if (t === "mgl64.Vec3") return "Vec3";
  if (t === "movement.Input") return "MovementInput";
  return null;
}

/**
 * Converts a Go type to a TypeScript type.
 * @param goType
 * @returns
 */
function tsForGoType(goType: string): string {
  // Arrays: []T
  const arrayMatch = /^\[\](.+)$/.exec(goType);
  if (arrayMatch) {
    const inner = tsForGoType(arrayMatch[1]);
    return `${inner}[]`;
  }

  // Maps: map[K]V
  const mapMatch = /^map\[[^\]]+\](.+)$/.exec(goType);
  if (mapMatch) {
    const v = tsForGoType(mapMatch[1]);
    return `{ [key: string]: ${v} }`;
  }

  const prim = goPrimitiveToTs(goType);
  if (prim) return prim;

  const ext = mapExternalGoTypeToTs(goType);
  if (ext) return ext;

  // Fallback to the base identifier (strip package qualifier)
  const base = goType.replace(/^\*+/, "").split(".").pop()!;
  return base;
}

/**
 * Generates a TypeScript interface for a Go struct.
 * @param s
 * @param allStructs
 * @param visited
 * @returns
 */
function generateTsForStruct(
  s: GoStruct,
  allStructs: Map<string, GoStruct>,
  visited: Set<string>,
): string {
  if (visited.has(s.name)) return "";
  visited.add(s.name);

  let out = "";

  // Generate dependencies first (for nested custom structs)
  for (const f of s.fields) {
    const goType = f.type.replace(/^\*+/, "");
    const arrayMatch = /^\[\](.+)$/.exec(goType);
    const baseType = arrayMatch ? arrayMatch[1] : goType;
    const baseId = baseType.split(".").pop()!;
    if (allStructs.has(baseId)) {
      out += generateTsForStruct(allStructs.get(baseId)!, allStructs, visited);
    }
  }

  // Compose interface fields
  const fieldLines: string[] = [];
  for (const f of s.fields) {
    // Skip callbacker or fields explicitly tagged to be ignored
    if (f.jsonTag === "_") continue;

    // Embedded fields (like movement.Input) expand to their TS type fields.
    if (f.name === null) {
      const t = mapExternalGoTypeToTs(f.type);
      if (t === "MovementInput") {
        fieldLines.push("  forward: boolean;");
        fieldLines.push("  back: boolean;");
        fieldLines.push("  left: boolean;");
        fieldLines.push("  right: boolean;");
        fieldLines.push("  jump: boolean;");
        fieldLines.push("  sneak: boolean;");
        continue;
      }
      // If embedded a known local struct, inline as intersection later isn't trivial; skip.
      // For unknown embedding, ignore to avoid wrong typings.
      continue;
    }

    // Determine property name
    const prop =
      f.jsonTag && f.jsonTag !== "" ? f.jsonTag.split(",")[0] : f.name;
    if (!prop || prop === "-") continue;

    const tsType = tsForGoType(f.type);
    if (f.doc) {
      fieldLines.push(formatJsDoc(f.doc, "  "));
    }
    fieldLines.push(`  ${prop}: ${tsType};`);
  }

  if (s.doc) {
    out += formatJsDoc(s.doc, "") + "\n";
  }
  out += `export interface ${s.name} {\n${fieldLines.join("\n")}\n}\n\n`;
  return out;
}

/**
 * Formats text into a JSDoc block with the given indentation.
 */
function formatJsDoc(text: string, indent: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return "";
  if (lines.length === 1) {
    return `${indent}/** ${lines[0]} */`;
  }
  const body = lines.map((l) => `${indent} * ${l}`).join("\n");
  return `${indent}/**\n${body}\n${indent} */`;
}

/**
 * Main function to generate TypeScript types.
 */
function main() {
  const files = listGoFiles(INSTRUCTION_DIR);
  const contents = files.map((filePath) => fs.readFileSync(filePath, "utf8"));

  // Aggregate all structs and instruction actions
  const allStructsArr = contents.flatMap(parseGoStructs);
  const allStructs = new Map(allStructsArr.map((s) => [s.name, s]));
  const instructions = contents.flatMap(parseInstructionActions);

  // Filter structs that are instructions (have Name() method)
  const instructionStructs = instructions
    .map((info) => allStructs.get(info.typeName))
    .filter((v): v is GoStruct => !!v);

  // Ensure output directory exists
  if (!fs.existsSync(GENERATED_DIR))
    fs.mkdirSync(GENERATED_DIR, { recursive: true });

  const visited = new Set<string>();
  let ts = "";
  ts += `// AUTO-GENERATED by scripts/generateTypes.ts. Do not edit manually.\n`;
  ts += `// Generated at ${new Date().toISOString()}\n\n`;
  ts += `// Shared external types mapped from Go:\n`;
  ts += `import { Face, Pos, Rotation, Vec3 } from "../types";\n\n`;

  // Generate auxiliary known local structs first if present
  const auxNames = ["Option", "Slot"];
  for (const n of auxNames) {
    const s = allStructs.get(n);
    if (s) ts += generateTsForStruct(s, allStructs, visited);
  }

  // Generate each instruction params interface named {TypeName}
  for (const s of instructionStructs) {
    ts += generateTsForStruct(s, allStructs, visited);
  }

  // Build discriminated unions for payloads
  const actionLiterals = instructions.map((i) => `'${i.action}'`).sort();
  ts += `export type InstructionAction = ${actionLiterals.join(" | ")};\n\n`;

  // Map action -> params interface
  ts += `export interface InstructionParametersByAction {\n`;
  for (const info of instructions.sort((a, b) =>
    a.action.localeCompare(b.action),
  )) {
    const iface = info.typeName;
    ts += `  '${info.action}': ${iface};\n`;
  }
  ts += `}\n\n`;

  // Discriminated union for full payloads
  ts += `export type InstructionPayload =\n`;
  ts += instructions
    .sort((a, b) => a.action.localeCompare(b.action))
    .map((info, idx, arr) => {
      const sep = idx === arr.length - 1 ? ";" : " |";
      return `  { action: '${info.action}'; parameters: ${info.typeName} }${sep}`;
    })
    .join("\n");
  ts += `\n`;

  // Write and prettify the file
  fs.writeFileSync(GENERATED_FILE, ts, "utf8");
  execSync(`npx prettier --write ${GENERATED_FILE}`);

  console.log(`Generated types to ${GENERATED_FILE}`);
}

main();
