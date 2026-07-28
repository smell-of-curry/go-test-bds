import type { CubeFaceName, CubeUv, FaceUv, Vec2 } from "./types";

export interface ResolvedFaceUv {
  /** Four corners in face-vertex order, each `[u, v]` in 0–1 GL space (V up). */
  corners: [Vec2, Vec2, Vec2, Vec2];
  materialInstance: string;
}

/**
 * Box-UV face placement relative to the `[u, v]` origin of a cube unwrap.
 * Matches Java/Bedrock entity box layout used by bridge-core `CubeFaces`.
 *
 * ```
 *         [u+d .. u+d+w] [u+d+w .. u+d+2w]
 *         UP             DOWN
 * [u..u+d][u+d..u+d+w][u+d+w..u+d+w+d][u+d+w+d..u+d+2w+d]
 * EAST    NORTH       WEST            SOUTH
 * ```
 */
const BOX_FACE_OFFSET: Record<
  CubeFaceName,
  {
    du: (w: number, h: number, d: number) => number;
    dv: (d: number) => number;
    su: "w" | "d";
    sv: "h" | "d";
  }
> = {
  east: { du: () => 0, dv: (d) => d, su: "d", sv: "h" },
  north: { du: (_w, _h, d) => d, dv: (d) => d, su: "w", sv: "h" },
  west: { du: (w, _h, d) => d + w, dv: (d) => d, su: "d", sv: "h" },
  south: { du: (w, _h, d) => d + w + d, dv: (d) => d, su: "w", sv: "h" },
  up: { du: (_w, _h, d) => d, dv: () => 0, su: "w", sv: "d" },
  down: { du: (w, _h, d) => d + w, dv: () => 0, su: "w", sv: "d" },
};

/**
 * Resolve UVs for one cube face into normalised GL coordinates.
 *
 * @param face - Face name.
 * @param cubeUv - Cube-level UV (box or per-face).
 * @param size - Inflated cube size `[w,h,d]` in model units (for box unwrap).
 * @param textureWidth - `description.texture_width`.
 * @param textureHeight - `description.texture_height`.
 * @param mirror - When true, flip U on the face (and swap east/west box slots).
 * @returns Resolved corners + material, or `null` if the face is omitted.
 */
export function resolveFaceUv(
  face: CubeFaceName,
  cubeUv: CubeUv | undefined,
  size: readonly [number, number, number],
  textureWidth: number,
  textureHeight: number,
  mirror: boolean,
): ResolvedFaceUv | null {
  if (cubeUv === undefined) {
    // No UV → still emit the face with a degenerate 0×0 rect at the origin.
    return {
      corners: [
        [0, 1],
        [0, 1],
        [0, 1],
        [0, 1],
      ],
      materialInstance: "",
    };
  }

  if (Array.isArray(cubeUv)) {
    const box = cubeUv as Vec2;
    return resolveBoxFace(face, box, size, textureWidth, textureHeight, mirror);
  }

  const perFace = cubeUv as Partial<Record<CubeFaceName, FaceUv>>;
  const mappedFace =
    mirror && (face === "east" || face === "west")
      ? face === "east"
        ? "west"
        : "east"
      : face;
  const faceUv = perFace[mappedFace];
  if (faceUv === undefined) return null;
  return resolvePerFace(faceUv, textureWidth, textureHeight, mirror);
}

/**
 * @param face - Face name.
 * @param start - Box UV origin `[u, v]` in texels.
 * @param size - `[w, h, d]`.
 * @param textureWidth - Texture width.
 * @param textureHeight - Texture height.
 * @param mirror - Mirror U / swap east-west slots.
 * @returns Resolved UV.
 */
function resolveBoxFace(
  face: CubeFaceName,
  start: Vec2,
  size: readonly [number, number, number],
  textureWidth: number,
  textureHeight: number,
  mirror: boolean,
): ResolvedFaceUv {
  const [w, h, d] = size;
  // Box UV sizes are floored (Bedrock rounds down texel extents).
  const fw = Math.floor(Math.abs(w));
  const fh = Math.floor(Math.abs(h));
  const fd = Math.floor(Math.abs(d));

  let useFace = face;
  if (mirror && (face === "east" || face === "west")) {
    useFace = face === "east" ? "west" : "east";
  }

  const layout = BOX_FACE_OFFSET[useFace];
  const su = layout.su === "w" ? fw : fd;
  const sv = layout.sv === "h" ? fh : fd;
  const u0 = start[0] + layout.du(fw, fh, fd);
  const v0 = start[1] + layout.dv(fd);

  // Face corner order matches mesh.ts FACE_VERTS (see there).
  // U increases with the face's "right", V increases downward in texel space.
  const texelCorners: [Vec2, Vec2, Vec2, Vec2] = faceCornersTexels(
    u0,
    v0,
    su,
    sv,
    mirror,
  );

  return {
    corners: [
      texelToGl(texelCorners[0], textureWidth, textureHeight),
      texelToGl(texelCorners[1], textureWidth, textureHeight),
      texelToGl(texelCorners[2], textureWidth, textureHeight),
      texelToGl(texelCorners[3], textureWidth, textureHeight),
    ],
    materialInstance: "",
  };
}

/**
 * @param faceUv - Per-face UV object.
 * @param textureWidth - Texture width.
 * @param textureHeight - Texture height.
 * @param mirror - Flip U when true.
 * @returns Resolved UV.
 */
function resolvePerFace(
  faceUv: FaceUv,
  textureWidth: number,
  textureHeight: number,
  mirror: boolean,
): ResolvedFaceUv {
  const [u, v] = faceUv.uv;
  const [su, sv] = faceUv.uvSize;
  // BL, BR, TR, TL in texel space (V down); matches mesh.ts face vert order.
  // `uv_size` sign flips the corresponding axis.
  let corners: [Vec2, Vec2, Vec2, Vec2] = [
    [u, v + sv],
    [u + su, v + sv],
    [u + su, v],
    [u, v],
  ];

  if (faceUv.uvRotation !== 0) {
    corners = rotateUvCorners(corners, faceUv.uvRotation);
  }
  if (mirror) {
    corners = [
      [u + su - (corners[0][0] - u), corners[0][1]],
      [u + su - (corners[1][0] - u), corners[1][1]],
      [u + su - (corners[2][0] - u), corners[2][1]],
      [u + su - (corners[3][0] - u), corners[3][1]],
    ];
  }

  return {
    corners: [
      texelToGl(corners[0], textureWidth, textureHeight),
      texelToGl(corners[1], textureWidth, textureHeight),
      texelToGl(corners[2], textureWidth, textureHeight),
      texelToGl(corners[3], textureWidth, textureHeight),
    ],
    materialInstance: faceUv.materialInstance ?? "",
  };
}

/**
 * Map face-local corner UVs for box mapping.
 * Output order: matches mesh.ts face vert winding — four corners.
 *
 * @param u0 - Texel left of face rect.
 * @param v0 - Texel top of face rect.
 * @param su - Width in texels.
 * @param sv - Height in texels.
 * @param mirror - Flip U within the face.
 * @returns Four texel corners in mesh vertex order.
 */
function faceCornersTexels(
  u0: number,
  v0: number,
  su: number,
  sv: number,
  mirror: boolean,
): [Vec2, Vec2, Vec2, Vec2] {
  // BL, BR, TR, TL in texel space (V increases downward).
  let corners: [Vec2, Vec2, Vec2, Vec2] = [
    [u0, v0 + sv],
    [u0 + su, v0 + sv],
    [u0 + su, v0],
    [u0, v0],
  ];
  if (mirror) {
    corners = [
      [u0 + su, v0 + sv],
      [u0, v0 + sv],
      [u0, v0],
      [u0 + su, v0],
    ];
  }
  return corners;
}

/**
 * Rotate a face's UV corners clockwise about the rect centre.
 *
 * @param corners - BL, BR, TR, TL.
 * @param degrees - 90 / 180 / 270.
 * @returns Rotated corners in the same slot order.
 */
function rotateUvCorners(
  corners: [Vec2, Vec2, Vec2, Vec2],
  degrees: 90 | 180 | 270,
): [Vec2, Vec2, Vec2, Vec2] {
  const [bl, br, tr, tl] = corners;
  if (degrees === 90) return [tl, bl, br, tr];
  if (degrees === 180) return [tr, tl, bl, br];
  return [br, tr, tl, bl]; // 270
}

/**
 * Texel (origin top-left, V down) → GL UV (origin bottom-left, V up).
 *
 * @param uv - Texel coordinate.
 * @param textureWidth - Texture width.
 * @param textureHeight - Texture height.
 * @returns Normalised GL UV.
 */
export function texelToGl(
  uv: Vec2,
  textureWidth: number,
  textureHeight: number,
): Vec2 {
  const w = textureWidth || 1;
  const h = textureHeight || 1;
  return [uv[0] / w, 1 - uv[1] / h];
}
