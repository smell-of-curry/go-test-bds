import * as THREE from "three";

/**
 * Wrap a tile-space coordinate into 0..1 for atlas sampling.
 * `fract(N) == 0` at the far edge of a greedy run would otherwise snap to the
 * start of the tile; map that edge to 1.0 (end of tile) instead.
 *
 * @param x - Tile-space U or V (0..N across a merge).
 * @returns wrapped 0..1 coordinate.
 */
export function wrapTileCoord(x: number): number {
  const f = x - Math.floor(x);
  if (f < 1e-5 && x > 1e-5) return 1;
  return f;
}

const VERT = /* glsl */ `
precision highp float;
precision highp int;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

in vec3 position;
in vec2 tileUv;
in vec4 atlasRect;
in float tileRot;
in vec3 vertColor;

out vec2 vTileUv;
out vec4 vAtlasRect;
out float vTileRot;
out vec3 vColor;
out float vFogDepth;

void main() {
  vTileUv = tileUv;
  vAtlasRect = atlasRect;
  vTileRot = tileRot;
  vColor = vertColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp int;

uniform sampler2D map;
uniform vec2 atlasSize;
uniform float alphaCutoff;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
uniform float fogEnabled;

in vec2 vTileUv;
in vec4 vAtlasRect;
in float vTileRot;
in vec3 vColor;
in float vFogDepth;

out vec4 fragColor;

float wrapTile(float x) {
  float f = fract(x);
  // Far edge of a merge: fract(N)==0 must sample the tile's end, not its start.
  return (f < 1e-5 && x > 1e-5) ? 1.0 : f;
}

vec2 rotateFrac(vec2 f, float rot) {
  float r = mod(floor(rot + 0.5), 4.0);
  if (r < 0.5) return f;
  if (r < 1.5) return vec2(f.y, 1.0 - f.x);
  if (r < 2.5) return vec2(1.0 - f.x, 1.0 - f.y);
  return vec2(1.0 - f.y, f.x);
}

void main() {
  vec2 f = rotateFrac(vec2(wrapTile(vTileUv.x), wrapTile(vTileUv.y)), vTileRot);
  vec2 halfTexel = 0.5 / atlasSize;
  vec2 origin = vAtlasRect.xy + halfTexel;
  vec2 size = max(vAtlasRect.zw - 2.0 * halfTexel, vec2(0.0));
  vec2 uv = origin + f * size;
  vec4 tex = texture(map, uv);
  if (tex.a < alphaCutoff) discard;
  // Vertex colour carries biome tint × face shade × light brightness × AO.
  vec3 rgb = tex.rgb * vColor;
  if (fogEnabled > 0.5) {
    float t = clamp((vFogDepth - fogNear) / max(fogFar - fogNear, 1e-3), 0.0, 1.0);
    rgb = mix(rgb, fogColor, t);
  }
  fragColor = vec4(rgb, 1.0);
}
`;

export interface TerrainMaterialOpts {
  map: THREE.Texture;
  atlasWidth: number;
  atlasHeight: number;
  /** When true: transparent blending, no depth write. */
  transparent?: boolean;
}

/**
 * Terrain material with tile-space UV → atlas rect; lighting is pre-baked into
 * `vertColor`. Optional linear distance fog (RawShader has no THREE.Fog hook).
 *
 * @param opts - Atlas texture + size + pass flags.
 * @returns RawShaderMaterial (GLSL3, no lights, no tone mapping).
 */
export function createTerrainMaterial(
  opts: TerrainMaterialOpts,
): THREE.RawShaderMaterial {
  const transparent = opts.transparent === true;
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      map: { value: opts.map },
      atlasSize: {
        value: new THREE.Vector2(opts.atlasWidth, opts.atlasHeight),
      },
      alphaCutoff: { value: transparent ? 0.1 : 0.01 },
      fogColor: { value: new THREE.Vector3(0.66, 0.83, 0.94) },
      fogNear: { value: 0 },
      fogFar: { value: 1 },
      fogEnabled: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent,
    depthWrite: !transparent,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
}
