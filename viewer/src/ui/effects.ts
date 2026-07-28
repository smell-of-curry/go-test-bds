import * as THREE from "three";

const BURST_MS = 450;
const PARTICLE_COUNT = 28;

interface Burst {
  points: THREE.Points;
  bornMs: number;
  velocities: Float32Array;
}

/**
 * Tiny block-break particle bursts (Stage 11 small scope).
 * Colour is gray unless a hex is supplied — no ActorEvent/LevelEvent decode.
 */
export class BlockBreakEffects {
  private readonly scene: THREE.Scene;
  private readonly bursts: Burst[] = [];

  /**
   * @param scene - Live THREE.Scene from ViewerScene (public handle).
   */
  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Spawn a short Points burst at each block position.
   *
   * @param positions - Integer block cells that just changed.
   * @param colorHex - Optional RGB; defaults to stone gray.
   */
  spawn(positions: Array<[number, number, number]>, colorHex = 0x8a8a8a): void {
    const now = performance.now();
    for (const pos of positions) {
      this.bursts.push(this.makeBurst(pos, colorHex, now));
    }
  }

  /**
   * Advance particle motion and drop expired bursts.
   *
   * @param nowMs - `performance.now()` from the paint loop.
   */
  tick(nowMs: number): void {
    const dt = 1 / 60;
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i]!;
      const age = nowMs - b.bornMs;
      if (age >= BURST_MS) {
        this.scene.remove(b.points);
        b.points.geometry.dispose();
        (b.points.material as THREE.PointsMaterial).dispose();
        this.bursts.splice(i, 1);
        continue;
      }
      const pos = b.points.geometry.getAttribute(
        "position",
      ) as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let p = 0; p < PARTICLE_COUNT; p++) {
        arr[p * 3]! += b.velocities[p * 3]! * dt;
        arr[p * 3 + 1]! += b.velocities[p * 3 + 1]! * dt;
        arr[p * 3 + 2]! += b.velocities[p * 3 + 2]! * dt;
        b.velocities[p * 3 + 1]! -= 9.0 * dt;
      }
      pos.needsUpdate = true;
      const mat = b.points.material as THREE.PointsMaterial;
      mat.opacity = 1 - age / BURST_MS;
    }
  }

  /** Active burst count (tests). */
  get count(): number {
    return this.bursts.length;
  }

  private makeBurst(
    pos: [number, number, number],
    colorHex: number,
    bornMs: number,
  ): Burst {
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const velocities = new Float32Array(PARTICLE_COUNT * 3);
    const ox = pos[0] + 0.5;
    const oy = pos[1] + 0.5;
    const oz = pos[2] + 0.5;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      positions[i * 3] = ox;
      positions[i * 3 + 1] = oy;
      positions[i * 3 + 2] = oz;
      velocities[i * 3] = (Math.random() - 0.5) * 3.2;
      velocities[i * 3 + 1] = Math.random() * 2.8 + 0.6;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 3.2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: colorHex,
      size: 0.08,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    points.name = `break:${pos.join(",")}`;
    this.scene.add(points);
    return { points, bornMs, velocities };
  }
}
