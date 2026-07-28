import { GeometryParseError } from "./errors";
import type {
  CubeFaceName,
  CubeUv,
  FaceUv,
  GeometryDocument,
  GeometryDescription,
  ParsedBone,
  ParsedCube,
  ParsedGeometry,
  ParsedLocator,
  ParsedPolyMesh,
  ParsedTextureMesh,
  Vec2,
  Vec3,
} from "./types";

const FACE_NAMES: CubeFaceName[] = [
  "north",
  "south",
  "east",
  "west",
  "up",
  "down",
];

/**
 * Parse a Bedrock `.geo.json` document (modern `minecraft:geometry` array or
 * legacy top-level `geometry.<name>` keys).
 *
 * @param input - Parsed JSON value (object).
 * @returns Normalised document with one or more geometries.
 * @throws {GeometryParseError} on malformed input.
 */
export function parseGeometryDocument(input: unknown): GeometryDocument {
  if (!isObject(input)) {
    throw new GeometryParseError("geometry document must be a JSON object");
  }

  const formatVersion = optionalString(input.format_version, "format_version");
  const modern = input["minecraft:geometry"];

  if (modern !== undefined) {
    if (!Array.isArray(modern)) {
      throw new GeometryParseError("minecraft:geometry must be an array");
    }
    if (modern.length === 0) {
      throw new GeometryParseError("minecraft:geometry array is empty");
    }
    return {
      formatVersion,
      geometries: modern.map((entry, i) =>
        parseGeometryEntry(entry, formatVersion, `minecraft:geometry[${i}]`),
      ),
    };
  }

  const legacyKeys = Object.keys(input).filter(
    (k) => k.startsWith("geometry.") && k !== "format_version",
  );
  if (legacyKeys.length === 0) {
    throw new GeometryParseError(
      "document has neither minecraft:geometry nor geometry.* keys",
    );
  }

  return {
    formatVersion,
    geometries: legacyKeys.map((key) =>
      parseLegacyGeometry(key, input[key], formatVersion),
    ),
  };
}

/**
 * @param entry - One `minecraft:geometry` element.
 * @param formatVersion - Document-level format version.
 * @param path - Error path prefix.
 * @returns Parsed geometry.
 * @throws {GeometryParseError} on malformed entry.
 */
function parseGeometryEntry(
  entry: unknown,
  formatVersion: string | undefined,
  path: string,
): ParsedGeometry {
  if (!isObject(entry)) {
    throw new GeometryParseError(`${path} must be an object`);
  }
  const description = parseDescription(
    entry.description,
    `${path}.description`,
  );
  const bonesRaw = entry.bones;
  if (bonesRaw !== undefined && !Array.isArray(bonesRaw)) {
    throw new GeometryParseError(`${path}.bones must be an array`);
  }
  const bones = (bonesRaw ?? []).map((b, i) =>
    parseBone(b, `${path}.bones[${i}]`),
  );
  validateBoneParents(bones, path);
  return { description, bones, formatVersion };
}

/**
 * @param key - Legacy top-level key (`geometry.foo`).
 * @param value - Geometry body.
 * @param formatVersion - Document-level format version.
 * @returns Parsed geometry.
 * @throws {GeometryParseError} on malformed legacy body.
 */
function parseLegacyGeometry(
  key: string,
  value: unknown,
  formatVersion: string | undefined,
): ParsedGeometry {
  if (!isObject(value)) {
    throw new GeometryParseError(`${key} must be an object`);
  }
  const textureWidth =
    optionalNumber(value.texturewidth, `${key}.texturewidth`) ??
    optionalNumber(value.texture_width, `${key}.texture_width`) ??
    16;
  const textureHeight =
    optionalNumber(value.textureheight, `${key}.textureheight`) ??
    optionalNumber(value.texture_height, `${key}.texture_height`) ??
    16;

  const description: GeometryDescription = {
    identifier: key,
    textureWidth,
    textureHeight,
    visibleBoundsWidth: optionalNumber(
      value.visible_bounds_width,
      `${key}.visible_bounds_width`,
    ),
    visibleBoundsHeight: optionalNumber(
      value.visible_bounds_height,
      `${key}.visible_bounds_height`,
    ),
    visibleBoundsOffset: optionalVec3(
      value.visible_bounds_offset,
      `${key}.visible_bounds_offset`,
    ),
  };

  const bonesRaw = value.bones;
  if (bonesRaw !== undefined && !Array.isArray(bonesRaw)) {
    throw new GeometryParseError(`${key}.bones must be an array`);
  }
  const bones = (bonesRaw ?? []).map((b, i) =>
    parseBone(b, `${key}.bones[${i}]`),
  );
  validateBoneParents(bones, key);
  return { description, bones, formatVersion };
}

/**
 * @param raw - `description` object.
 * @param path - Error path.
 * @returns Parsed description.
 * @throws {GeometryParseError} when identifier missing / wrong type.
 */
function parseDescription(raw: unknown, path: string): GeometryDescription {
  if (!isObject(raw)) {
    throw new GeometryParseError(`${path} must be an object`);
  }
  const identifier = requiredString(raw.identifier, `${path}.identifier`);
  return {
    identifier,
    textureWidth:
      optionalNumber(raw.texture_width, `${path}.texture_width`) ?? 16,
    textureHeight:
      optionalNumber(raw.texture_height, `${path}.texture_height`) ?? 16,
    visibleBoundsWidth: optionalNumber(
      raw.visible_bounds_width,
      `${path}.visible_bounds_width`,
    ),
    visibleBoundsHeight: optionalNumber(
      raw.visible_bounds_height,
      `${path}.visible_bounds_height`,
    ),
    visibleBoundsOffset: optionalVec3(
      raw.visible_bounds_offset,
      `${path}.visible_bounds_offset`,
    ),
  };
}

/**
 * @param raw - Bone object.
 * @param path - Error path.
 * @returns Parsed bone.
 * @throws {GeometryParseError} on malformed bone.
 */
function parseBone(raw: unknown, path: string): ParsedBone {
  if (!isObject(raw)) {
    throw new GeometryParseError(`${path} must be an object`);
  }
  const name = requiredString(raw.name, `${path}.name`);
  const parent =
    raw.parent === undefined || raw.parent === null
      ? null
      : requiredString(raw.parent, `${path}.parent`);

  const cubesRaw = raw.cubes;
  if (cubesRaw !== undefined && !Array.isArray(cubesRaw)) {
    throw new GeometryParseError(`${path}.cubes must be an array`);
  }

  return {
    name,
    parent,
    pivot: optionalVec3(raw.pivot, `${path}.pivot`) ?? [0, 0, 0],
    rotation: optionalVec3(raw.rotation, `${path}.rotation`) ?? [0, 0, 0],
    bindPoseRotation: optionalVec3(
      raw.bind_pose_rotation,
      `${path}.bind_pose_rotation`,
    ),
    mirror: optionalBoolean(raw.mirror, `${path}.mirror`) ?? false,
    inflate: optionalNumber(raw.inflate, `${path}.inflate`),
    binding:
      raw.binding === undefined
        ? undefined
        : requiredString(raw.binding, `${path}.binding`),
    locators: parseLocators(raw.locators, `${path}.locators`),
    cubes: (cubesRaw ?? []).map((c, i) => parseCube(c, `${path}.cubes[${i}]`)),
    polyMesh:
      raw.poly_mesh === undefined
        ? undefined
        : parsePolyMesh(raw.poly_mesh, `${path}.poly_mesh`),
    textureMeshes: parseTextureMeshes(
      raw.texture_meshes,
      `${path}.texture_meshes`,
    ),
  };
}

/**
 * @param raw - Cube object.
 * @param path - Error path.
 * @returns Parsed cube.
 * @throws {GeometryParseError} on malformed cube.
 */
function parseCube(raw: unknown, path: string): ParsedCube {
  if (!isObject(raw)) {
    throw new GeometryParseError(`${path} must be an object`);
  }
  return {
    origin: optionalVec3(raw.origin, `${path}.origin`) ?? [0, 0, 0],
    size: optionalVec3(raw.size, `${path}.size`) ?? [0, 0, 0],
    rotation: optionalVec3(raw.rotation, `${path}.rotation`) ?? [0, 0, 0],
    pivot: optionalVec3(raw.pivot, `${path}.pivot`),
    // Omit when absent so bone-level inflate can apply (bridge: cube ?? bone).
    inflate: optionalNumber(raw.inflate, `${path}.inflate`),
    mirror:
      raw.mirror === undefined
        ? undefined
        : (optionalBoolean(raw.mirror, `${path}.mirror`) ?? false),
    uv: raw.uv === undefined ? undefined : parseCubeUv(raw.uv, `${path}.uv`),
  };
}

/**
 * @param raw - `[u,v]` or per-face object.
 * @param path - Error path.
 * @returns Parsed UV.
 * @throws {GeometryParseError} on malformed UV.
 */
function parseCubeUv(raw: unknown, path: string): CubeUv {
  if (Array.isArray(raw)) {
    return requiredVec2(raw, path);
  }
  if (!isObject(raw)) {
    throw new GeometryParseError(`${path} must be [u,v] or a per-face object`);
  }
  const out: Partial<Record<CubeFaceName, FaceUv>> = {};
  for (const face of FACE_NAMES) {
    if (raw[face] === undefined) continue;
    out[face] = parseFaceUv(raw[face], `${path}.${face}`);
  }
  return out;
}

/**
 * @param raw - One face UV object.
 * @param path - Error path.
 * @returns Parsed face UV.
 * @throws {GeometryParseError} on malformed face.
 */
function parseFaceUv(raw: unknown, path: string): FaceUv {
  if (!isObject(raw)) {
    throw new GeometryParseError(`${path} must be an object`);
  }
  const uv = requiredVec2(raw.uv, `${path}.uv`);
  const uvSize = optionalVec2(raw.uv_size, `${path}.uv_size`) ?? [0, 0];
  const rotRaw = optionalNumber(raw.uv_rotation, `${path}.uv_rotation`) ?? 0;
  if (rotRaw !== 0 && rotRaw !== 90 && rotRaw !== 180 && rotRaw !== 270) {
    throw new GeometryParseError(
      `${path}.uv_rotation must be 0, 90, 180, or 270 (got ${rotRaw})`,
    );
  }
  return {
    uv,
    uvSize,
    materialInstance:
      raw.material_instance === undefined
        ? undefined
        : requiredString(raw.material_instance, `${path}.material_instance`),
    uvRotation: rotRaw as 0 | 90 | 180 | 270,
  };
}

/**
 * @param raw - Locators map.
 * @param path - Error path.
 * @returns Parsed locators.
 * @throws {GeometryParseError} on malformed locator.
 */
function parseLocators(
  raw: unknown,
  path: string,
): Record<string, ParsedLocator> {
  if (raw === undefined) return {};
  if (!isObject(raw)) {
    throw new GeometryParseError(`${path} must be an object`);
  }
  const out: Record<string, ParsedLocator> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      out[name] = {
        offset: requiredVec3(value, `${path}.${name}`),
        rotation: [0, 0, 0],
        ignoreInheritedScale: false,
      };
      continue;
    }
    if (!isObject(value)) {
      throw new GeometryParseError(
        `${path}.${name} must be [x,y,z] or {offset,rotation,...}`,
      );
    }
    out[name] = {
      offset: optionalVec3(value.offset, `${path}.${name}.offset`) ?? [0, 0, 0],
      rotation: optionalVec3(value.rotation, `${path}.${name}.rotation`) ?? [
        0, 0, 0,
      ],
      ignoreInheritedScale:
        optionalBoolean(
          value.ignore_inherited_scale,
          `${path}.${name}.ignore_inherited_scale`,
        ) ?? false,
    };
  }
  return out;
}

/**
 * @param raw - `poly_mesh` object.
 * @param path - Error path.
 * @returns Parsed poly mesh.
 * @throws {GeometryParseError} on malformed poly_mesh.
 */
function parsePolyMesh(raw: unknown, path: string): ParsedPolyMesh {
  if (!isObject(raw)) {
    throw new GeometryParseError(`${path} must be an object`);
  }
  if (typeof raw.polys === "string") {
    throw new GeometryParseError(
      `${path}.polys string form (tri_list/quad_list) is not supported; use indexed polys`,
    );
  }
  if (!Array.isArray(raw.polys)) {
    throw new GeometryParseError(`${path}.polys must be an array of polygons`);
  }

  const positions = (asArray(raw.positions, `${path}.positions`) ?? []).map(
    (p, i) => requiredVec3(p, `${path}.positions[${i}]`),
  );
  const normals = (asArray(raw.normals, `${path}.normals`) ?? []).map((n, i) =>
    requiredVec3(n, `${path}.normals[${i}]`),
  );
  const uvs = (asArray(raw.uvs, `${path}.uvs`) ?? []).map((u, i) =>
    requiredVec2(u, `${path}.uvs[${i}]`),
  );

  const polys = raw.polys.map((poly, pi) => {
    if (!Array.isArray(poly) || (poly.length !== 3 && poly.length !== 4)) {
      throw new GeometryParseError(
        `${path}.polys[${pi}] must be a tri or quad of [pos,normal,uv] indices`,
      );
    }
    return poly.map((vert, vi) => {
      if (!Array.isArray(vert) || vert.length < 3) {
        throw new GeometryParseError(
          `${path}.polys[${pi}][${vi}] must be [positionIndex, normalIndex, uvIndex]`,
        );
      }
      const a = vert[0];
      const b = vert[1];
      const c = vert[2];
      if (
        typeof a !== "number" ||
        typeof b !== "number" ||
        typeof c !== "number"
      ) {
        throw new GeometryParseError(
          `${path}.polys[${pi}][${vi}] indices must be numbers`,
        );
      }
      return [a, b, c] as const;
    });
  });

  return {
    positions,
    normals,
    uvs,
    polys,
    normalizedUvs:
      optionalBoolean(raw.normalized_uvs, `${path}.normalized_uvs`) ?? false,
  };
}

/**
 * @param raw - `texture_meshes` array.
 * @param path - Error path.
 * @returns Parsed texture meshes.
 * @throws {GeometryParseError} on malformed entries.
 */
function parseTextureMeshes(raw: unknown, path: string): ParsedTextureMesh[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new GeometryParseError(`${path} must be an array`);
  }
  return raw.map((entry, i) => {
    const p = `${path}[${i}]`;
    if (!isObject(entry)) {
      throw new GeometryParseError(`${p} must be an object`);
    }
    return {
      texture: requiredString(entry.texture, `${p}.texture`),
      position: optionalVec3(entry.position, `${p}.position`) ?? [0, 0, 0],
      rotation: optionalVec3(entry.rotation, `${p}.rotation`) ?? [0, 0, 0],
      localPivot: optionalVec3(entry.local_pivot, `${p}.local_pivot`) ?? [
        0, 0, 0,
      ],
      scale: optionalVec3(entry.scale, `${p}.scale`) ?? [1, 1, 1],
      usePixelDepth:
        optionalBoolean(entry.use_pixel_depth, `${p}.use_pixel_depth`) ?? true,
    };
  });
}

/**
 * @param bones - Parsed bones.
 * @param path - Error path prefix.
 * @throws {GeometryParseError} on duplicate names or missing parents.
 */
function validateBoneParents(bones: ParsedBone[], path: string): void {
  const names = new Set<string>();
  for (const b of bones) {
    if (names.has(b.name)) {
      throw new GeometryParseError(`${path}: duplicate bone name '${b.name}'`);
    }
    names.add(b.name);
  }
  for (const b of bones) {
    if (b.parent !== null && !names.has(b.parent)) {
      throw new GeometryParseError(
        `${path}: bone '${b.name}' parents missing bone '${b.parent}'`,
      );
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray(v: unknown, path: string): unknown[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    throw new GeometryParseError(`${path} must be an array`);
  }
  return v;
}

function requiredString(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new GeometryParseError(`${path} must be a non-empty string`);
  }
  return v;
}

function optionalString(v: unknown, path: string): string | undefined {
  if (v === undefined) return undefined;
  return requiredString(v, path);
}

function optionalBoolean(v: unknown, path: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") {
    throw new GeometryParseError(`${path} must be a boolean`);
  }
  return v;
}

function optionalNumber(v: unknown, path: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new GeometryParseError(`${path} must be a finite number`);
  }
  return v;
}

function requiredVec3(v: unknown, path: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3) {
    throw new GeometryParseError(`${path} must be [x, y, z]`);
  }
  const [x, y, z] = v;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof z !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z)
  ) {
    throw new GeometryParseError(`${path} must contain finite numbers`);
  }
  return [x, y, z];
}

function optionalVec3(v: unknown, path: string): Vec3 | undefined {
  if (v === undefined) return undefined;
  return requiredVec3(v, path);
}

function requiredVec2(v: unknown, path: string): Vec2 {
  if (!Array.isArray(v) || v.length !== 2) {
    throw new GeometryParseError(`${path} must be [u, v]`);
  }
  const [u, vv] = v;
  if (
    typeof u !== "number" ||
    typeof vv !== "number" ||
    !Number.isFinite(u) ||
    !Number.isFinite(vv)
  ) {
    throw new GeometryParseError(`${path} must contain finite numbers`);
  }
  return [u, vv];
}

function optionalVec2(v: unknown, path: string): Vec2 | undefined {
  if (v === undefined) return undefined;
  return requiredVec2(v, path);
}
