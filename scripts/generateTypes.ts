// This will read the instructions from @gotestbds/instruction and generate TypeScript types.
// Output is written to scripts/__generated__/types.ts

import * as fs from "fs";
import * as path from "path";

type GoStructField = {
  name: string | null; // null => embedded field
  type: string;
  jsonTag?: string;
};

type GoStruct = {
  name: string;
  fields: GoStructField[];
};

type InstructionInfo = {
  typeName: string;
  action: string; // value returned by Name()
};

const ROOT = path.resolve(__dirname, "..");
const INSTRUCTION_DIR = path.resolve(ROOT, "gotestbds", "instruction");
const GENERATED_DIR = path.resolve(__dirname, "__generated__");
const GENERATED_FILE = path.join(GENERATED_DIR, "types.ts");

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function listGoFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".go"))
    .map((f) => path.join(dir, f));
}

function parseGoStructs(content: string): GoStruct[] {
  const structs: GoStruct[] = [];
  const structRegex =
    /type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\s*\{([\s\S]*?)\}/g;
  let match: RegExpExecArray | null;
  while ((match = structRegex.exec(content))) {
    const [, name, body] = match;
    const fields: GoStructField[] = [];
    const lines = body.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//")) continue;
      // Handle trailing comments and struct closing
      const cleaned = line.replace(/\s*\/\/.*$/, "").replace(/,$/, "");
      if (!cleaned) continue;

      // Match with explicit name:  FieldName Type `json:"..."`
      let m =
        /^(\*?[A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_\*\.\[\]]+)(?:\s+`[^`]*json:"([^"]+)"[^`]*`)?/.exec(
          cleaned,
        );
      if (m) {
        const [, fieldName, fieldType, jsonTag] = m;
        fields.push({ name: fieldName, type: fieldType, jsonTag });
        continue;
      }

      // Embedded field: e.g., movement.Input or *movement.Input
      m =
        /^(\*?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)(?:\s+`[^`]*json:"([^"]+)"[^`]*`)?/.exec(
          cleaned,
        );
      if (m) {
        const [, fieldType, jsonTag] = m;
        fields.push({ name: null, type: fieldType, jsonTag });
        continue;
      }
    }
    structs.push({ name, fields });
  }
  return structs;
}

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

function mapExternalGoTypeToTs(goType: string): string | null {
  const t = goType.replace(/^\*+/, "");
  if (t === "cube.Pos") return "Pos";
  if (t === "cube.Rotation") return "Rotation";
  if (t === "cube.Face") return "Face";
  if (t === "mgl64.Vec3") return "Vec3";
  if (t === "movement.Input") return "MovementInput";
  return null;
}

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
    fieldLines.push(`  ${prop}: ${tsType};`);
  }

  out += `export interface ${s.name} {\n${fieldLines.join("\n")}\n}\n\n`;
  return out;
}

function main() {
  const files = listGoFiles(INSTRUCTION_DIR);
  const contents = files.map(readFile);

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
  ts += `export type Vec3 = [number, number, number];\n`;
  ts += `export type Pos = { x: number; y: number; z: number };\n`;
  ts += `export type Rotation = { yaw: number; pitch: number };\n`;
  ts += `export type Face = 0 | 1 | 2 | 3 | 4 | 5;\n`;
  ts += `export type MovementInput = { forward: boolean; back: boolean; left: boolean; right: boolean; jump: boolean; sneak: boolean };\n\n`;

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

  fs.writeFileSync(GENERATED_FILE, ts, "utf8");
}

main();
