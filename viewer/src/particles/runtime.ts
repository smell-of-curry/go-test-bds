import * as THREE from "three";
import {
  createDefaultHost,
  type DefaultMolangHost,
  type RandomSource,
  zeroRandom,
} from "../molang";
import { applyCurves } from "./curves";
import { evalExpr, evalVec3 } from "./expr";
import { createParticlePointsMaterial } from "./material";
import { sampleTintGradient } from "./parse";
import type { ParsedParticleEffect } from "./types";

/** Soft cap on live particles across all emitters. */
export const MAX_LIVE_PARTICLES = 4096;

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  lifetime: number;
  rotation: number;
  rotationRate: number;
  random: [number, number, number, number];
  size: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

interface EmitterInstance {
  effect: ParsedParticleEffect;
  origin: [number, number, number];
  age: number;
  active: boolean;
  sleeping: boolean;
  sleepAge: number;
  activeTime: number;
  sleepTime: number;
  spawnAcc: number;
  emitterRandom: [number, number, number, number];
  particles: Particle[];
  variables: Record<string, number>;
  bornAt: number;
  points: THREE.Points | null;
  material: THREE.PointsMaterial;
}

export interface ParticleSystemOptions {
  /** Injectable RNG (defaults to {@link zeroRandom}). */
  random?: RandomSource;
  /** Max live particles before oldest emitters are culled. */
  maxParticles?: number;
}

export interface ParticleDebugHandle {
  readonly emitterCount: number;
  readonly particleCount: number;
  readonly unsupportedComponents: readonly string[];
}

/**
 * Molang-driven particle runtime. Emitters simulate on the render tick;
 * particles render as THREE.Points with the effect material / texture.
 */
export class ParticleSystem {
  private readonly scene: THREE.Scene;
  private readonly random: RandomSource;
  private readonly maxParticles: number;
  private readonly emitters: EmitterInstance[] = [];
  private readonly textures = new Map<string, THREE.Texture | null>();
  private readonly unsupportedLogged = new Set<string>();
  private readonly allUnsupported: string[] = [];
  private nextBorn = 0;

  /**
   * @param scene - Live THREE.Scene.
   * @param opts - RNG / cap overrides.
   */
  constructor(scene: THREE.Scene, opts: ParticleSystemOptions = {}) {
    this.scene = scene;
    this.random = opts.random ?? zeroRandom;
    this.maxParticles = opts.maxParticles ?? MAX_LIVE_PARTICLES;
  }

  /** Debug counters for tests / overlay. */
  get debug(): ParticleDebugHandle {
    let particles = 0;
    for (const e of this.emitters) particles += e.particles.length;
    return {
      emitterCount: this.emitters.length,
      particleCount: particles,
      unsupportedComponents: this.allUnsupported,
    };
  }

  /** Active emitter count (includes empty-but-alive emitters). */
  get emitterCount(): number {
    return this.emitters.length;
  }

  /** Total live particles. */
  get particleCount(): number {
    let n = 0;
    for (const e of this.emitters) n += e.particles.length;
    return n;
  }

  /**
   * Register a texture for an effect path (pack-relative, no extension).
   *
   * @param texturePath - Effect `basic_render_parameters.texture`.
   * @param texture - Decoded THREE texture, or null to mark missing.
   */
  setTexture(texturePath: string, texture: THREE.Texture | null): void {
    this.textures.set(texturePath.toLowerCase(), texture);
  }

  /**
   * Spawn an emitter for a parsed effect at a world position.
   *
   * @param effect - Parsed particle JSON.
   * @param position - World xyz.
   * @param variables - Optional emitter-local variable overrides.
   * @returns the emitter (for tests).
   */
  spawn(
    effect: ParsedParticleEffect,
    position: [number, number, number],
    variables: Record<string, number> = {},
  ): void {
    for (const u of effect.unsupportedComponents) {
      const key = `${effect.identifier}:${u}`;
      if (!this.unsupportedLogged.has(key)) {
        this.unsupportedLogged.add(key);
        this.allUnsupported.push(key);
      }
    }

    const host = this.makeHost(null, null, [
      this.random.next(),
      this.random.next(),
      this.random.next(),
      this.random.next(),
    ]);
    for (const [k, v] of Object.entries(variables)) {
      host.setVariable(k.toLowerCase(), v);
    }

    const tex = this.textures.get(effect.texture.toLowerCase()) ?? null;
    const material = createParticlePointsMaterial(effect.material, tex);
    const activeTime =
      effect.lifetime?.kind === "once" || effect.lifetime?.kind === "looping"
        ? Math.max(0, evalExpr(effect.lifetime.activeTime, host))
        : 1;
    const sleepTime =
      effect.lifetime?.kind === "looping"
        ? Math.max(0, evalExpr(effect.lifetime.sleepTime, host))
        : 0;

    const emitter: EmitterInstance = {
      effect,
      origin: [...position],
      age: 0,
      active: true,
      sleeping: false,
      sleepAge: 0,
      activeTime,
      sleepTime,
      spawnAcc: 0,
      emitterRandom: [
        this.random.next(),
        this.random.next(),
        this.random.next(),
        this.random.next(),
      ],
      particles: [],
      variables: { ...variables },
      bornAt: this.nextBorn++,
      points: null,
      material,
    };

    if (effect.rate?.kind === "instant") {
      const n = Math.max(
        0,
        Math.floor(evalExpr(effect.rate.numParticles, host)),
      );
      for (let i = 0; i < n; i++) this.birthParticle(emitter);
    }

    this.emitters.push(emitter);
    this.enforceCap();
  }

  /**
   * Advance all emitters by `dtSec` and refresh GPU buffers.
   *
   * @param dtSec - Frame delta in seconds.
   */
  tick(dtSec: number): void {
    const dt = Math.min(0.25, Math.max(0, dtSec));
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i]!;
      this.tickEmitter(e, dt);
      if (!e.active && e.particles.length === 0) {
        this.disposeEmitter(e);
        this.emitters.splice(i, 1);
      }
    }
  }

  /** Drop every emitter (tests / scene teardown). */
  clear(): void {
    for (const e of this.emitters) this.disposeEmitter(e);
    this.emitters.length = 0;
  }

  private tickEmitter(e: EmitterInstance, dt: number): void {
    if (e.sleeping) {
      e.sleepAge += dt;
      if (e.sleepAge >= e.sleepTime) {
        e.sleeping = false;
        e.sleepAge = 0;
        e.age = 0;
        e.active = true;
        if (e.effect.rate?.kind === "instant") {
          const host = this.emitterHost(e);
          const n = Math.max(
            0,
            Math.floor(evalExpr(e.effect.rate.numParticles, host)),
          );
          for (let i = 0; i < n; i++) this.birthParticle(e);
        }
      }
    } else if (e.active) {
      e.age += dt;
      const life = e.effect.lifetime;
      if (life?.kind === "expression") {
        const host = this.emitterHost(e);
        if (life.expiration && evalExpr(life.expiration, host) !== 0) {
          e.active = false;
        }
      } else if (life?.kind === "once" && e.age >= e.activeTime) {
        e.active = false;
      } else if (life?.kind === "looping" && e.age >= e.activeTime) {
        e.active = false;
        e.sleeping = true;
        e.sleepAge = 0;
      } else if (!life && e.effect.rate?.kind === "instant" && e.age > 0) {
        // Instant + no lifetime → expire emitter after first spawn tick.
        e.active = false;
      }

      if (e.active && e.effect.rate?.kind === "steady") {
        const host = this.emitterHost(e);
        const rate = Math.max(0, evalExpr(e.effect.rate.spawnRate, host));
        const maxP = Math.max(0, evalExpr(e.effect.rate.maxParticles, host));
        e.spawnAcc += rate * dt;
        while (e.spawnAcc >= 1 && e.particles.length < maxP) {
          e.spawnAcc -= 1;
          this.birthParticle(e);
        }
      }
    }

    for (let i = e.particles.length - 1; i >= 0; i--) {
      const p = e.particles[i]!;
      p.age += dt;
      if (p.age >= p.lifetime) {
        e.particles.splice(i, 1);
        continue;
      }
      this.integrateParticle(e, p, dt);
      if (e.effect.killPlane) {
        const [a, b, c, d] = e.effect.killPlane;
        if (a * p.x + b * p.y + c * p.z + d > 0) {
          e.particles.splice(i, 1);
        }
      }
    }

    this.syncPoints(e);
  }

  private integrateParticle(e: EmitterInstance, p: Particle, dt: number): void {
    const host = this.particleHost(e, p);
    applyCurves(e.effect.curves, host);

    if (e.effect.motionParametric) {
      const mp = e.effect.motionParametric;
      if (mp.relativePosition) {
        const [rx, ry, rz] = evalVec3(mp.relativePosition, host);
        p.x = e.origin[0] + rx;
        p.y = e.origin[1] + ry;
        p.z = e.origin[2] + rz;
      }
      if (mp.direction) {
        const [dx, dy, dz] = evalVec3(mp.direction, host);
        p.vx = dx;
        p.vy = dy;
        p.vz = dz;
      }
    } else if (e.effect.motionDynamic) {
      const md = e.effect.motionDynamic;
      const [ax, ay, az] = evalVec3(md.linearAcceleration, host);
      const drag = evalExpr(md.linearDrag, host);
      p.vx += ax * dt;
      p.vy += ay * dt;
      p.vz += az * dt;
      if (drag !== 0) {
        const f = Math.max(0, 1 - drag * dt);
        p.vx *= f;
        p.vy *= f;
        p.vz *= f;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const rotAcc = evalExpr(md.rotationAcceleration, host);
      const rotDrag = evalExpr(md.rotationDrag, host);
      p.rotationRate += rotAcc * dt;
      if (rotDrag !== 0) p.rotationRate *= Math.max(0, 1 - rotDrag * dt);
      p.rotation += p.rotationRate * dt;
    } else {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rotation += p.rotationRate * dt;
    }

    this.updateAppearance(e, p, host);
  }

  private updateAppearance(
    e: EmitterInstance,
    p: Particle,
    host: DefaultMolangHost,
  ): void {
    const bb = e.effect.billboard;
    if (bb) {
      const [sx] = [evalExpr(bb.size[0], host), evalExpr(bb.size[1], host)];
      p.size = Math.max(0.01, sx);
    }
    const tint = e.effect.tinting;
    if (!tint) {
      p.r = p.g = p.b = 0.85;
      p.a = 1;
      return;
    }
    if (tint.kind === "rgba") {
      p.r = evalExpr(tint.channels[0], host);
      p.g = evalExpr(tint.channels[1], host);
      p.b = evalExpr(tint.channels[2], host);
      p.a = evalExpr(tint.channels[3], host);
      return;
    }
    const t = evalExpr(tint.interpolant, host);
    const stops = tint.stops.map((s) => ({
      t: s.t,
      rgba: [
        evalExpr(s.channels[0], host),
        evalExpr(s.channels[1], host),
        evalExpr(s.channels[2], host),
        evalExpr(s.channels[3], host),
      ] as [number, number, number, number],
    }));
    const rgba = sampleTintGradient(stops, t);
    p.r = rgba[0];
    p.g = rgba[1];
    p.b = rgba[2];
    p.a = rgba[3];
  }

  private birthParticle(e: EmitterInstance): void {
    const pr: Particle["random"] = [
      this.random.next(),
      this.random.next(),
      this.random.next(),
      this.random.next(),
    ];
    const host = this.makeHost(e, null, pr);
    for (const [k, v] of Object.entries(e.variables)) {
      host.setVariable(k.toLowerCase(), v);
    }
    applyCurves(e.effect.curves, host);

    const lifetime = Math.max(
      0.05,
      e.effect.particleMaxLifetime
        ? evalExpr(e.effect.particleMaxLifetime, host)
        : 1,
    );
    host.setVariable("particle_lifetime", lifetime);

    const [ox, oy, oz] = this.sampleShapePosition(e, host);
    let [dx, dy, dz] = this.sampleShapeDirection(e, host, ox, oy, oz);
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    const speed = e.effect.initialSpeed
      ? evalExpr(e.effect.initialSpeed, host)
      : 0;

    const p: Particle = {
      x: e.origin[0] + ox,
      y: e.origin[1] + oy,
      z: e.origin[2] + oz,
      vx: dx * speed,
      vy: dy * speed,
      vz: dz * speed,
      age: 0,
      lifetime,
      rotation: e.effect.initialRotation
        ? evalExpr(e.effect.initialRotation, host)
        : 0,
      rotationRate: e.effect.initialRotationRate
        ? evalExpr(e.effect.initialRotationRate, host)
        : 0,
      random: pr,
      size: 0.1,
      r: 0.85,
      g: 0.85,
      b: 0.85,
      a: 1,
    };
    this.updateAppearance(e, p, this.particleHost(e, p));
    e.particles.push(p);
  }

  private sampleShapePosition(
    e: EmitterInstance,
    host: DefaultMolangHost,
  ): [number, number, number] {
    const shape = e.effect.shape;
    if (!shape || shape.kind === "unsupported") return [0, 0, 0];
    const [offx, offy, offz] = evalVec3(shape.offset, host);
    if (shape.kind === "point") return [offx, offy, offz];
    if (shape.kind === "sphere") {
      const r = Math.max(0, evalExpr(shape.radius, host));
      const u = this.random.next();
      const v = this.random.next();
      const theta = u * Math.PI * 2;
      const phi = Math.acos(2 * v - 1);
      const rad = shape.surfaceOnly ? r : r * Math.cbrt(this.random.next());
      return [
        offx + rad * Math.sin(phi) * Math.cos(theta),
        offy + rad * Math.cos(phi),
        offz + rad * Math.sin(phi) * Math.sin(theta),
      ];
    }
    if (shape.kind === "box") {
      const [hx, hy, hz] = evalVec3(shape.halfDimensions, host);
      if (shape.surfaceOnly) {
        const face = Math.floor(this.random.next() * 6);
        const a = this.random.next() * 2 - 1;
        const b = this.random.next() * 2 - 1;
        if (face === 0) return [offx + hx, offy + a * hy, offz + b * hz];
        if (face === 1) return [offx - hx, offy + a * hy, offz + b * hz];
        if (face === 2) return [offx + a * hx, offy + hy, offz + b * hz];
        if (face === 3) return [offx + a * hx, offy - hy, offz + b * hz];
        if (face === 4) return [offx + a * hx, offy + b * hy, offz + hz];
        return [offx + a * hx, offy + b * hy, offz - hz];
      }
      return [
        offx + (this.random.next() * 2 - 1) * hx,
        offy + (this.random.next() * 2 - 1) * hy,
        offz + (this.random.next() * 2 - 1) * hz,
      ];
    }
    // disc
    const r = Math.max(0, evalExpr(shape.radius, host));
    const [nx, ny, nz] = evalVec3(shape.planeNormal, host);
    const nlen = Math.hypot(nx, ny, nz) || 1;
    const nnx = nx / nlen;
    const nny = ny / nlen;
    const nnz = nz / nlen;
    // Build tangent basis.
    const ax = Math.abs(nnx) < 0.9 ? 1 : 0;
    const tx = nny * 0 - nnz * ax;
    const ty = nnz * ax - nnx * 0;
    const tz = nnx * ax - nny * 0;
    const tlen = Math.hypot(tx, ty, tz) || 1;
    const bx = nny * (tz / tlen) - nnz * (ty / tlen);
    const by = nnz * (tx / tlen) - nnx * (tz / tlen);
    const bz = nnx * (ty / tlen) - nny * (tx / tlen);
    const ang = this.random.next() * Math.PI * 2;
    const rad = shape.surfaceOnly ? r : r * Math.sqrt(this.random.next());
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    return [
      offx + (tx / tlen) * cos * rad + bx * sin * rad,
      offy + (ty / tlen) * cos * rad + by * sin * rad,
      offz + (tz / tlen) * cos * rad + bz * sin * rad,
    ];
  }

  private sampleShapeDirection(
    e: EmitterInstance,
    host: DefaultMolangHost,
    ox: number,
    oy: number,
    oz: number,
  ): [number, number, number] {
    const shape = e.effect.shape;
    if (!shape || shape.kind === "unsupported") return [0, 1, 0];
    const dir = shape.direction;
    if (dir === "outwards") {
      const len = Math.hypot(ox, oy, oz);
      return len > 1e-6 ? [ox / len, oy / len, oz / len] : [0, 1, 0];
    }
    if (dir === "inwards") {
      const len = Math.hypot(ox, oy, oz);
      return len > 1e-6 ? [-ox / len, -oy / len, -oz / len] : [0, -1, 0];
    }
    return evalVec3(dir, host);
  }

  private syncPoints(e: EmitterInstance): void {
    const n = e.particles.length;
    if (n === 0) {
      if (e.points) {
        this.scene.remove(e.points);
        e.points.geometry.dispose();
        e.points = null;
      }
      return;
    }
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    let avgSize = 0;
    for (let i = 0; i < n; i++) {
      const p = e.particles[i]!;
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      colors[i * 3] = p.r;
      colors[i * 3 + 1] = p.g;
      colors[i * 3 + 2] = p.b;
      avgSize += p.size;
    }
    avgSize /= n;
    e.material.size = Math.max(0.02, avgSize);
    e.material.opacity = 1;

    if (!e.points) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      e.points = new THREE.Points(geo, e.material);
      e.points.name = `particle:${e.effect.identifier}`;
      this.scene.add(e.points);
    } else {
      const geo = e.points.geometry;
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geo.attributes.position!.needsUpdate = true;
      geo.attributes.color!.needsUpdate = true;
    }
  }

  private enforceCap(): void {
    while (this.particleCount > this.maxParticles && this.emitters.length > 0) {
      // Drop oldest emitter first.
      let oldest = 0;
      for (let i = 1; i < this.emitters.length; i++) {
        if (this.emitters[i]!.bornAt < this.emitters[oldest]!.bornAt)
          oldest = i;
      }
      const [dead] = this.emitters.splice(oldest, 1);
      if (dead) this.disposeEmitter(dead);
    }
  }

  private disposeEmitter(e: EmitterInstance): void {
    if (e.points) {
      this.scene.remove(e.points);
      e.points.geometry.dispose();
      e.points = null;
    }
    e.material.dispose();
    e.particles.length = 0;
  }

  private emitterHost(e: EmitterInstance): DefaultMolangHost {
    return this.makeHost(e, null, e.emitterRandom);
  }

  private particleHost(e: EmitterInstance, p: Particle): DefaultMolangHost {
    return this.makeHost(e, p, p.random);
  }

  private makeHost(
    e: EmitterInstance | null,
    p: Particle | null,
    particleRandom: [number, number, number, number],
  ): DefaultMolangHost {
    const variables: Record<string, number> = {};
    if (e) {
      Object.assign(variables, e.variables);
      variables.emitter_age = e.age;
      variables.emitter_lifetime = e.activeTime;
      variables.emitter_random_1 = e.emitterRandom[0];
      variables.emitter_random_2 = e.emitterRandom[1];
      variables.emitter_random_3 = e.emitterRandom[2];
      variables.emitter_random_4 = e.emitterRandom[3];
    }
    if (p) {
      variables.particle_age = p.age;
      variables.particle_lifetime = p.lifetime;
      variables.particle_random_1 = particleRandom[0];
      variables.particle_random_2 = particleRandom[1];
      variables.particle_random_3 = particleRandom[2];
      variables.particle_random_4 = particleRandom[3];
    } else {
      variables.particle_random_1 = particleRandom[0];
      variables.particle_random_2 = particleRandom[1];
      variables.particle_random_3 = particleRandom[2];
      variables.particle_random_4 = particleRandom[3];
    }
    return createDefaultHost({ variables, random: this.random });
  }
}
