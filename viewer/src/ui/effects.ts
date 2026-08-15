import type { ParticleRegistry, ParticleSystem } from "../particles";
import { parseParticleEffect, type ParsedParticleEffect } from "../particles";

/** Vanilla terrain-break effect (needs atlas.terrain — usually unusable here). */
const VANILLA_BREAK = "minecraft:breaking_item_terrain";

/** Built-in gray burst when pack effect is missing / atlas-only. */
const FALLBACK_BREAK_JSON = {
  format_version: "1.10.0",
  particle_effect: {
    description: {
      identifier: "viewer:block_break_fallback",
      basic_render_parameters: {
        material: "particles_alpha",
        texture: "textures/particle/particles",
      },
    },
    components: {
      "minecraft:emitter_lifetime_once": { active_time: 0.05 },
      "minecraft:emitter_rate_instant": { num_particles: 28 },
      "minecraft:emitter_shape_point": {
        direction: [
          "math.random(-1, 1)",
          "math.random(0.2, 1)",
          "math.random(-1, 1)",
        ],
      },
      "minecraft:particle_initial_speed": "math.random(1.2, 3.2)",
      "minecraft:particle_lifetime_expression": {
        max_lifetime: "math.random(0.25, 0.45)",
      },
      "minecraft:particle_motion_dynamic": {
        linear_acceleration: [0, -9.0, 0],
        linear_drag_coefficient: 0.5,
      },
      "minecraft:particle_appearance_billboard": {
        size: [0.08, 0.08],
        facing_camera_mode: "lookat_xyz",
        uv: {
          texture_width: 128,
          texture_height: 128,
          uv: [0, 0],
          uv_size: [8, 8],
        },
      },
      "minecraft:particle_appearance_tinting": {
        color: [0.54, 0.54, 0.54, 1],
      },
    },
  },
};

const FALLBACK_EFFECT = parseParticleEffect(FALLBACK_BREAK_JSON);

/**
 * Block-break bursts via the Stage 11 particle system.
 * Tries the vanilla break effect when the registry can resolve a non-atlas
 * texture; otherwise the built-in gray fallback.
 */
export class BlockBreakEffects {
  private readonly system: ParticleSystem;
  private readonly getRegistry: () => ParticleRegistry | null;
  private vanilla: ParsedParticleEffect | null = null;
  private vanillaTried = false;
  private bursts = 0;

  /**
   * @param system - Shared particle runtime (owned by ViewerScene).
   * @param getRegistry - Optional pack registry getter (may become non-null later).
   */
  constructor(
    system: ParticleSystem,
    getRegistry: () => ParticleRegistry | null = () => null,
  ) {
    this.system = system;
    this.getRegistry = getRegistry;
  }

  /**
   * Spawn a short burst at each block position.
   *
   * @param positions - Integer block cells that just changed.
   * @param _colorHex - Ignored (tint comes from the effect JSON).
   */
  spawn(
    positions: Array<[number, number, number]>,
    _colorHex = 0x8a8a8a,
  ): void {
    void this.ensureVanilla();
    const effect = this.usableVanilla() ?? FALLBACK_EFFECT;
    const vars: Record<string, number> =
      effect.identifier === VANILLA_BREAK
        ? { emitter_radius: 0.4, size_modifier: 1, speed_modifier: 1 }
        : {};
    for (const pos of positions) {
      this.system.spawn(
        effect,
        [pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5],
        vars,
      );
      this.bursts++;
    }
  }

  /**
   * Advance is owned by {@link ParticleSystem.tick} on the scene — no-op here
   * so HUD's existing `effects.tick` call stays harmless.
   *
   * @param _nowMs - Unused.
   */
  tick(_nowMs: number): void {
    /* scene → particles.tick */
  }

  /** Break bursts requested this session (tests assert &gt; 0 after a block delta). */
  get count(): number {
    return this.bursts;
  }

  private usableVanilla(): ParsedParticleEffect | null {
    if (!this.vanilla) return null;
    if (this.vanilla.texture.toLowerCase().startsWith("atlas.")) return null;
    return this.vanilla;
  }

  private async ensureVanilla(): Promise<void> {
    const registry = this.getRegistry();
    if (!registry) return;
    if (this.vanillaTried) return;
    this.vanillaTried = true;
    const effect = await registry.get(VANILLA_BREAK);
    if (!effect) return;
    await registry.bindTexture(this.system, effect);
    this.vanilla = effect;
  }
}
