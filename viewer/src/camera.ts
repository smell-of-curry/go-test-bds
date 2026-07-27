import * as THREE from "three";
import type { Actor } from "./protocol";

export type CameraMode = "firstPerson" | "orbit";

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

export class CameraController {
  readonly perspective: THREE.PerspectiveCamera;
  mode: CameraMode = "firstPerson";

  private readonly orbitTarget = new THREE.Vector3();
  private orbitYaw = 0;
  private orbitPitch = 0.4;
  private orbitDistance = 12;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(aspect: number) {
    this.perspective = new THREE.PerspectiveCamera(70, aspect, 0.05, 2000);
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
  }

  toggleMode(): CameraMode {
    this.mode = this.mode === "firstPerson" ? "orbit" : "firstPerson";
    return this.mode;
  }

  resize(aspect: number): void {
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
  }

  /**
   * Attach orbit-drag listeners. First-person ignores pointer input — the
   * camera is locked to the actor's eye.
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

  update(actor: Actor | null): void {
    if (this.mode === "firstPerson") {
      if (actor) applyActorEye(this.perspective, actor);
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
