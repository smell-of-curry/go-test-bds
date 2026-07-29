import * as THREE from "three";
import type { Actor } from "./protocol";
import type { CameraWire } from "./protocol";

export type CameraMode = "firstPerson" | "follow" | "orbit";

const MODE_CYCLE: readonly CameraMode[] = ["firstPerson", "follow", "orbit"];

/**
 * Vertical FOV degrees. Current PerspectiveCamera default (kept for golden
 * stability). Bedrock first-person is ~66°; we do not switch the base to 66
 * because that would shift every golden/capture frame.
 */
export const DEFAULT_FOV = 70;

/** Sprint FOV widen (degrees added to base). */
export const SPRINT_FOV_BONUS = 4;

/** Bedrock third-person distance (blocks behind the actor). */
export const FOLLOW_BACK = 4;
/** Height above feet for the follow camera. */
export const FOLLOW_UP = 2.5;
/** Look-at height above feet (torso). */
export const FOLLOW_LOOK_Y = 1.4;
/** Minimum camera distance when occluded. */
export const FOLLOW_MIN_DIST = 0.4;
/** View-bob amplitude in blocks (follow mode, on-ground motion). */
export const BOB_AMPLITUDE = 0.035;

/**
 * Parse `?camera=` from the page query string.
 *
 * Accepts `follow`, `orbit`, `first`, or `firstPerson`. Unknown / absent values
 * leave the default (`firstPerson`) so interactive smoke stays aimed at the
 * fixture wall; the capture harness passes `camera=follow` explicitly.
 *
 * @param search - `location.search` (including leading `?`).
 * @returns resolved mode.
 */
export function cameraModeFromSearch(search: string): CameraMode {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const raw = (params.get("camera") ?? "").toLowerCase();
  if (raw === "follow") return "follow";
  if (raw === "orbit") return "orbit";
  if (raw === "first" || raw === "firstperson") return "firstPerson";
  return "firstPerson";
}

/**
 * View bobbing is OFF by default (goldens / captures stay deterministic).
 * Pass `?bobbing=1` to enable in follow mode.
 *
 * @param search - `location.search`.
 * @returns whether bobbing is enabled.
 */
export function bobbingFromSearch(search: string): boolean {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const raw = (params.get("bobbing") ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/**
 * Resolve vertical FOV from actor sprint + optional server camera FOV.
 *
 * @param base - Default FOV degrees.
 * @param actor - Observed bot (sprint flag), or null.
 * @param overrideFov - Server instruction FOV, or null/undefined.
 * @returns FOV degrees.
 */
export function resolveFov(
  base: number,
  actor: Actor | null,
  overrideFov: number | null | undefined,
): number {
  if (overrideFov != null && Number.isFinite(overrideFov)) return overrideFov;
  return base + (actor?.sprinting ? SPRINT_FOV_BONUS : 0);
}

/**
 * Bedrock `rot: [yaw, pitch]` (degrees) → Three.js camera orientation.
 *
 * Convention used here:
 * - Bedrock yaw 0 faces +Z (south); yaw increases westward (90 = west, 180 = north).
 * - Bedrock pitch 0 is horizontal; positive pitch looks down.
 * - Three.js camera default looks down −Z; Y-up; rotation order `YXZ`.
 * - Mapping: `rotation.y = π − yawRad`, `rotation.x = pitchRad`.
 *   (yaw 180 → north/−Z → y=0; yaw 0 → south/+Z → y=π; positive pitch → look down.)
 */
export function applyActorEye(
  camera: THREE.PerspectiveCamera,
  actor: Actor,
): void {
  const [x, y, z] = actor.eyePos;
  camera.position.set(x, y, z);
  const yaw = THREE.MathUtils.degToRad(actor.rot[0]);
  const pitch = THREE.MathUtils.degToRad(actor.rot[1]);
  camera.rotation.order = "YXZ";
  camera.rotation.x = pitch;
  camera.rotation.y = Math.PI - yaw;
  camera.rotation.z = 0;
}

/**
 * Ideal follow-camera position (before occlusion / bob).
 *
 * @param actor - Observed bot pose.
 * @returns world position behind and above the actor.
 */
export function followIdealPos(actor: Actor): THREE.Vector3 {
  const yaw = THREE.MathUtils.degToRad(actor.rot[0]);
  const fx = -Math.sin(yaw);
  const fz = Math.cos(yaw);
  const [ax, ay, az] = actor.pos;
  return new THREE.Vector3(
    ax - fx * FOLLOW_BACK,
    ay + FOLLOW_UP,
    az - fz * FOLLOW_BACK,
  );
}

/**
 * Place the camera behind and above the actor, looking at its torso.
 *
 * @param camera - Perspective camera to position.
 * @param actor - Observed bot pose (uses `pos` + yaw).
 * @param occludeMeshes - Optional terrain meshes for a single pull-in ray.
 * @param bobY - Extra Y offset from view bobbing.
 */
export function applyFollowCamera(
  camera: THREE.PerspectiveCamera,
  actor: Actor,
  occludeMeshes?: THREE.Object3D[],
  bobY = 0,
): void {
  const [ax, ay, az] = actor.pos;
  const look = new THREE.Vector3(ax, ay + FOLLOW_LOOK_Y, az);
  let pos = followIdealPos(actor);
  pos.y += bobY;

  if (occludeMeshes && occludeMeshes.length > 0) {
    pos = occludePullIn(look, pos, occludeMeshes);
  }

  camera.position.copy(pos);
  camera.up.set(0, 1, 0);
  camera.lookAt(look);
}

const _raycaster = new THREE.Raycaster();
const _dir = new THREE.Vector3();

/**
 * Pull the follow camera in along the look→ideal ray if terrain blocks it.
 *
 * @param look - Look-at point (torso).
 * @param ideal - Ideal camera position.
 * @param meshes - Terrain objects to test.
 * @returns adjusted position.
 */
export function occludePullIn(
  look: THREE.Vector3,
  ideal: THREE.Vector3,
  meshes: THREE.Object3D[],
): THREE.Vector3 {
  _dir.subVectors(ideal, look);
  const dist = _dir.length();
  if (dist < 1e-4) return ideal.clone();
  _dir.multiplyScalar(1 / dist);
  _raycaster.set(look, _dir);
  _raycaster.far = dist;
  const hits = _raycaster.intersectObjects(meshes, true);
  if (hits.length === 0) return ideal.clone();
  const hitDist = Math.max(FOLLOW_MIN_DIST, hits[0]!.distance - 0.15);
  return look.clone().addScaledVector(_dir, hitDist);
}

/**
 * Sinusoidal view-bob Y offset while moving on ground.
 *
 * @param actor - Observed bot.
 * @param timeSec - Monotonic seconds.
 * @param enabled - Master toggle (query param).
 * @param mode - Active camera mode.
 * @returns Y offset in blocks.
 */
export function viewBobOffset(
  actor: Actor,
  timeSec: number,
  enabled: boolean,
  mode: CameraMode,
): number {
  if (!enabled || mode !== "follow") return 0;
  if (!actor.onGround) return 0;
  const speed = Math.hypot(actor.vel[0], actor.vel[2]);
  if (speed < 0.01) return 0;
  return Math.sin(timeSec * 10) * BOB_AMPLITUDE;
}

/** Pure lerp helper for camera ease (unit tests). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Ease progress in `[0,1]` from elapsed ms and duration.
 *
 * @param elapsedMs - Time since ease start.
 * @param durationMs - Total ease duration (0 = snap).
 * @returns progress.
 */
export function easeProgress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1;
  return Math.min(1, Math.max(0, elapsedMs / durationMs));
}

/**
 * Apply server camera override (position + rotation) with optional ease.
 *
 * @param camera - Perspective camera.
 * @param override - Wire camera state.
 * @param fromPos - Ease start position (current camera).
 * @param fromRot - Ease start `[yaw, pitch]` degrees, or null to snap rot.
 * @param progress - Ease progress `[0,1]`.
 */
export function applyServerCamera(
  camera: THREE.PerspectiveCamera,
  override: CameraWire,
  fromPos: THREE.Vector3,
  fromRot: [number, number] | null,
  progress: number,
): void {
  if (!override.pos) return;
  const [tx, ty, tz] = override.pos;
  const t = progress;
  camera.position.set(
    lerp(fromPos.x, tx, t),
    lerp(fromPos.y, ty, t),
    lerp(fromPos.z, tz, t),
  );
  if (override.rot) {
    const yaw = override.rot[0];
    const pitch = override.rot[1];
    const fy = fromRot?.[0] ?? yaw;
    const fp = fromRot?.[1] ?? pitch;
    const y = lerp(fy, yaw, t);
    const p = lerp(fp, pitch, t);
    camera.rotation.order = "YXZ";
    camera.rotation.x = THREE.MathUtils.degToRad(p);
    camera.rotation.y = Math.PI - THREE.MathUtils.degToRad(y);
    camera.rotation.z = 0;
  }
}

export class CameraController {
  readonly perspective: THREE.PerspectiveCamera;
  mode: CameraMode;
  bobbingEnabled: boolean;

  private readonly orbitTarget = new THREE.Vector3();
  private orbitYaw = 0;
  private orbitPitch = 0.4;
  private orbitDistance = 12;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  /** Active server override from the store (null = follow/default). */
  serverOverride: CameraWire | null = null;
  private easeFromPos = new THREE.Vector3();
  private easeFromRot: [number, number] | null = null;
  private easeStartMs = 0;
  private easeDurationMs = 0;
  private easeActive = false;
  private lastOverrideKey = "";
  private bobTimeSec = 0;
  private occludeMeshes: THREE.Object3D[] = [];

  constructor(
    aspect: number,
    mode: CameraMode = "firstPerson",
    bobbingEnabled = false,
  ) {
    this.perspective = new THREE.PerspectiveCamera(
      DEFAULT_FOV,
      aspect,
      0.05,
      2000,
    );
    this.mode = mode;
    this.bobbingEnabled = bobbingEnabled;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
  }

  /**
   * Cycle first-person → follow → orbit → first-person.
   *
   * @returns the mode after the toggle.
   */
  toggleMode(): CameraMode {
    const i = MODE_CYCLE.indexOf(this.mode);
    this.mode = MODE_CYCLE[(i + 1) % MODE_CYCLE.length]!;
    return this.mode;
  }

  resize(aspect: number): void {
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
  }

  /**
   * Terrain meshes for follow-camera occlusion (single ray).
   *
   * @param meshes - Section mesh roots.
   */
  setOccludeMeshes(meshes: THREE.Object3D[]): void {
    this.occludeMeshes = meshes;
  }

  /**
   * Apply or clear a server camera override. Starts an ease when duration > 0.
   *
   * @param override - Wire camera, or null to return to follow/default.
   * @param nowMs - `performance.now()`.
   */
  setServerOverride(override: CameraWire | null, nowMs: number): void {
    const key = override
      ? JSON.stringify([
          override.pos,
          override.rot,
          override.easeDurationMs,
          override.fov,
        ])
      : "";
    if (key === this.lastOverrideKey) {
      this.serverOverride = override;
      return;
    }
    this.lastOverrideKey = key;
    if (override?.pos) {
      this.easeFromPos.copy(this.perspective.position);
      this.easeFromRot = null;
      this.easeDurationMs = override.easeDurationMs ?? 0;
      this.easeStartMs = nowMs;
      this.easeActive = this.easeDurationMs > 0;
    } else {
      this.easeActive = false;
    }
    this.serverOverride = override;
  }

  /**
   * Attach orbit-drag listeners. First-person and follow ignore pointer input.
   *
   * @param el - Element that receives pointer events (usually the canvas).
   * @returns disposer.
   */
  bindOrbitControls(el: HTMLElement): () => void {
    const onDown = (e: PointerEvent) => {
      if (this.mode !== "orbit") return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!this.dragging || this.mode !== "orbit") return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.orbitYaw -= dx * 0.005;
      this.orbitPitch = Math.max(
        -1.4,
        Math.min(1.4, this.orbitPitch - dy * 0.005),
      );
    };
    const onUp = (e: PointerEvent) => {
      this.dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (this.mode !== "orbit") return;
      this.orbitDistance = Math.max(
        2,
        Math.min(80, this.orbitDistance + e.deltaY * 0.02),
      );
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("wheel", onWheel);
    };
  }

  /**
   * @param actor - Pose to frame (interpolated pose from the render loop).
   * @param dtSec - Frame delta seconds (bobbing clock).
   * @param nowMs - `performance.now()` for ease.
   */
  update(actor: Actor | null, dtSec = 0, nowMs = 0): void {
    this.bobTimeSec += dtSec;
    const fov = resolveFov(
      DEFAULT_FOV,
      actor,
      this.serverOverride?.fov ?? null,
    );
    if (this.perspective.fov !== fov) {
      this.perspective.fov = fov;
      this.perspective.updateProjectionMatrix();
    }

    if (this.serverOverride?.pos) {
      const p = this.easeActive
        ? easeProgress(nowMs - this.easeStartMs, this.easeDurationMs)
        : 1;
      if (p >= 1) this.easeActive = false;
      applyServerCamera(
        this.perspective,
        this.serverOverride,
        this.easeFromPos,
        this.easeFromRot,
        p,
      );
      return;
    }

    if (this.mode === "firstPerson") {
      if (actor) applyActorEye(this.perspective, actor);
      return;
    }
    if (this.mode === "follow") {
      if (actor) {
        const bob = viewBobOffset(
          actor,
          this.bobTimeSec,
          this.bobbingEnabled,
          this.mode,
        );
        applyFollowCamera(this.perspective, actor, this.occludeMeshes, bob);
      }
      return;
    }
    if (actor) {
      this.orbitTarget.set(actor.pos[0], actor.pos[1] + 1.6, actor.pos[2]);
    }
    const cp = Math.cos(this.orbitPitch);
    this.perspective.position.set(
      this.orbitTarget.x + Math.sin(this.orbitYaw) * cp * this.orbitDistance,
      this.orbitTarget.y + Math.sin(this.orbitPitch) * this.orbitDistance,
      this.orbitTarget.z + Math.cos(this.orbitYaw) * cp * this.orbitDistance,
    );
    this.perspective.lookAt(this.orbitTarget);
  }
}
