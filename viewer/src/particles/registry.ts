import * as THREE from "three";
import type { AssetClient } from "../terrain/assetClient";
import { normalizePath } from "../terrain/assetClient";
import { parseParticleEffect } from "./parse";
import type { ParticleSystem } from "./runtime";
import type { ParsedParticleEffect } from "./types";

/**
 * Lazy loader for particle JSON + textures from the pack stack.
 */
export class ParticleRegistry {
  private readonly client: AssetClient;
  private readonly cache = new Map<string, ParsedParticleEffect | null>();
  private readonly pending = new Map<
    string,
    Promise<ParsedParticleEffect | null>
  >();
  /** path → identifier, filled as files are fetched. */
  private readonly pathIds = new Map<string, string>();
  private particlePaths: string[] | null = null;

  /**
   * @param client - Shared pack asset client.
   */
  constructor(client: AssetClient) {
    this.client = client;
  }

  /**
   * Resolve and parse an effect by identifier.
   *
   * @param identifier - e.g. `minecraft:basic_smoke_particle`.
   * @returns parsed effect, or null if missing / unreadable.
   */
  async get(identifier: string): Promise<ParsedParticleEffect | null> {
    const id = identifier.toLowerCase();
    if (this.cache.has(id)) return this.cache.get(id)!;
    let p = this.pending.get(id);
    if (!p) {
      p = this.load(id);
      this.pending.set(id, p);
    }
    return p;
  }

  /**
   * Ensure the effect's texture is registered on a runtime.
   *
   * @param system - Particle runtime.
   * @param effect - Parsed effect.
   */
  async bindTexture(
    system: ParticleSystem,
    effect: ParsedParticleEffect,
  ): Promise<void> {
    const key = effect.texture.toLowerCase();
    // atlas.* is a terrain-atlas virtual path — Points can't sample it; skip.
    if (key.startsWith("atlas.")) {
      system.setTexture(effect.texture, null);
      return;
    }
    const bmp = await this.client.fetchImage(effect.texture);
    if (!bmp) {
      system.setTexture(effect.texture, null);
      return;
    }
    const tex = new THREE.Texture();
    tex.image = bmp;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    system.setTexture(effect.texture, tex);
  }

  private async load(id: string): Promise<ParsedParticleEffect | null> {
    const candidates = await this.candidatePaths(id);
    for (const path of candidates) {
      try {
        const json = await this.client.fetchJson(path);
        if (!json) continue;
        const effect = parseParticleEffect(json);
        this.cache.set(id, effect);
        this.cache.set(effect.identifier.toLowerCase(), effect);
        this.pathIds.set(normalizePath(path), effect.identifier.toLowerCase());
        return effect;
      } catch {
        /* try next */
      }
    }
    this.cache.set(id, null);
    return null;
  }

  private async candidatePaths(id: string): Promise<string[]> {
    const bare = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
    const out: string[] = [];
    const push = (p: string): void => {
      const n = normalizePath(p);
      if (!out.includes(n)) out.push(n);
    };
    push(`particles/${bare}.json`);
    push(`particles/${bare}.particle.json`);
    // Filename match against pack index (handles weather/ subfolders, etc.).
    const paths = await this.listParticlePaths();
    const needle = bare.toLowerCase();
    for (const path of paths) {
      const file = path.slice(path.lastIndexOf("/") + 1);
      if (
        file === `${needle}.json` ||
        file === `${needle}.particle.json` ||
        file.replace(/\.particle\.json$/i, "").replace(/\.json$/i, "") ===
          needle
      ) {
        push(path);
      }
    }
    return out;
  }

  private async listParticlePaths(): Promise<string[]> {
    if (this.particlePaths) return this.particlePaths;
    const idx = await this.client.getIndex();
    this.particlePaths = Object.keys(idx).filter(
      (p) => p.startsWith("particles/") && p.endsWith(".json"),
    );
    return this.particlePaths;
  }
}
