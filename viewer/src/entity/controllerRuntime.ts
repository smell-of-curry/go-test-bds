/**
 * Per-entity animation playback: scripts block + animation controllers +
 * bone sampling.
 *
 * Ordering (MS Learn / bedrock.dev):
 * 1. `scripts.initialize` — once per instance
 * 2. each frame: `scripts.pre_animation` (in order)
 * 3. `scripts.animate` entries (short name or `{name: condition}`); controllers
 *    and animations share the entity `animations` short-name map
 * 4. Controllers: evaluate transitions (first non-zero, one/frame), then play
 *    state animations with weights; `blend_transition` cross-fades leaving state
 *
 * Variables (`variable.*`) persist on the host across frames.
 */

import { evaluate, type DefaultMolangHost, type MolangValue } from "../molang";
import { asNumber, isTruthy } from "../molang/value";
import {
  advanceAnimTime,
  applyBonePoses,
  emptyBonePose,
  isAnimationFinished,
  resetBonesToRest,
  sampleAnimation,
  type BoneAnimPose,
} from "./animation";
import type { BuiltEntityModel } from "./buildModel";
import type { ParsedAnimController } from "./parseAnimController";
import type { ParsedAnimation } from "./parseAnimation";
import { createEntityMolangHost } from "./queries";
import type { ClientEntityScripts, EntityRenderInputs } from "./types";

/** Short-name → animation or controller. */
export interface AnimationBindings {
  animations: Map<string, ParsedAnimation>;
  controllers: Map<string, ParsedAnimController>;
  /** short name → full animation / controller identifier. */
  shortNames: Record<string, string>;
  scripts: ClientEntityScripts;
}

/** Snapshot fields the runtime needs each frame. */
export interface AnimEntityState {
  type: string;
  player: boolean;
  pos: [number, number, number];
  rot: [number, number] | [number, number, number];
  vel: [number, number, number];
  flags: Record<string, boolean>;
  props: Record<string, string | number | boolean>;
  attributes: Record<string, number>;
}

/** One playing animation instance (root or inside a controller). */
interface PlayingAnim {
  shortName: string;
  anim: ParsedAnimation;
  animTime: number;
  /** Start-delay countdown (seconds); <0 means playing. */
  delayLeft: number;
  weight: number;
  /** Controller that owns this play, if any. */
  controllerId?: string;
}

/** Controller instance state. */
interface ControllerInst {
  def: ParsedAnimController;
  state: string;
  /** Previous state during blend, or null. */
  blendFrom: string | null;
  blendT: number;
  blendDuration: number;
  /** Per-state animation playheads keyed shortName. */
  playheads: Map<string, { animTime: number; delayLeft: number }>;
}

/**
 * Mutable per-entity animator. Call {@link EntityAnimator.tick} each frame.
 */
export class EntityAnimator {
  private readonly bindings: AnimationBindings;
  private readonly host: DefaultMolangHost;
  private initialized = false;
  private lifeTime = 0;
  private distanceMoved = 0;
  private lastPos: [number, number, number] | null = null;
  private readonly rootPlay = new Map<string, PlayingAnim>();
  private readonly controllers = new Map<string, ControllerInst>();
  /** Last controller-state names (for tests). */
  readonly stateLog: string[] = [];

  /**
   * @param bindings - Pack animations + scripts for this entity type.
   * @param seedInputs - Initial props/flags for the Molang host.
   */
  constructor(bindings: AnimationBindings, seedInputs: EntityRenderInputs) {
    this.bindings = bindings;
    this.host = createEntityMolangHost(seedInputs);
  }

  /**
   * Access the persistent Molang host (tests / debug).
   *
   * @returns default host with variables.
   */
  get molangHost(): DefaultMolangHost {
    return this.host;
  }

  /**
   * Current controller state names (controllerId → state).
   *
   * @returns state map.
   */
  controllerStates(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, c] of this.controllers) out[id] = c.state;
    return out;
  }

  /**
   * Advance time, evaluate scripts/controllers, apply bones.
   *
   * @param dt - Frame delta seconds.
   * @param ent - Latest entity pose/state.
   * @param model - Built model (bones), or null to skip apply.
   * @returns sampled bone poses for this frame.
   */
  tick(
    dt: number,
    ent: AnimEntityState,
    model: BuiltEntityModel | null,
  ): Map<string, BoneAnimPose> {
    const delta = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.lifeTime += delta;
    this.trackDistance(ent.pos);

    this.syncQueries(ent, delta);
    this.refreshFlagQueries(ent);

    if (!this.initialized) {
      this.runScriptList(this.bindings.scripts.initialize);
      this.initialized = true;
      this.bootControllers();
    }

    this.runScriptList(this.bindings.scripts.pre_animation);

    const activeRoot = new Map<string, number>();
    for (const entry of this.bindings.scripts.animate) {
      let weight = 1;
      if (entry.condition) {
        const w = this.evalNumber(entry.condition);
        if (!isTruthy(w)) continue;
        weight = asNumber(w);
      }
      activeRoot.set(entry.name, weight);
      this.ensureRootPlay(entry.name, weight);
    }
    for (const [name, play] of [...this.rootPlay]) {
      if (play.controllerId) continue;
      const w = activeRoot.get(name);
      if (w === undefined) this.rootPlay.delete(name);
      else play.weight = w;
    }

    this.tickControllers(delta);
    this.advancePlayheads(delta);

    const poses = new Map<string, BoneAnimPose>();
    this.sampleAll(poses);

    if (model) {
      resetBonesToRest(model.bones);
      applyBonePoses(model.bones, poses, ent.rot[1] ?? 0);
    }
    return poses;
  }

  /**
   * Evaluate poses only (no THREE) — for unit tests.
   *
   * @param dt - Delta.
   * @param ent - Entity state.
   * @returns bone poses.
   */
  tickPoses(dt: number, ent: AnimEntityState): Map<string, BoneAnimPose> {
    return this.tick(dt, ent, null);
  }

  /**
   * @param pos - Current feet position.
   */
  private trackDistance(pos: [number, number, number]): void {
    if (this.lastPos) {
      const dx = pos[0] - this.lastPos[0];
      const dz = pos[2] - this.lastPos[2];
      this.distanceMoved += Math.hypot(dx, dz);
    }
    this.lastPos = [pos[0], pos[1], pos[2]];
  }

  /**
   * @param ent - Entity.
   * @param delta - dt seconds.
   */
  private syncQueries(ent: AnimEntityState, delta: number): void {
    const speed = Math.hypot(ent.vel[0], ent.vel[2]);
    this.host.setQuery("life_time", this.lifeTime);
    this.host.setQuery("delta_time", delta);
    this.host.setQuery("anim_time", 0);
    this.host.setQuery("modified_distance_moved", this.distanceMoved);
    this.host.setQuery("modified_move_speed", speed);
    this.host.setQuery("ground_speed", speed);
    this.host.setQuery("vertical_speed", ent.vel[1]);
    this.host.setQuery("position_delta", [
      ent.vel[0] * delta,
      ent.vel[1] * delta,
      ent.vel[2] * delta,
    ]);
    const hp = ent.attributes["minecraft:health"] ?? ent.attributes.health;
    if (typeof hp === "number") this.host.setQuery("health", hp);
  }

  /**
   * Refresh flag / property queries from the latest snapshot.
   *
   * @param ent - Entity.
   */
  private refreshFlagQueries(ent: AnimEntityState): void {
    const flags = ent.flags;
    this.host.setQuery(
      "is_sneaking",
      flags.sneaking || flags.is_sneaking ? 1 : 0,
    );
    this.host.setQuery(
      "is_on_ground",
      (flags.on_ground ?? flags.is_on_ground ?? true) ? 1 : 0,
    );
    this.host.setQuery(
      "is_in_water",
      flags.in_water || flags.is_in_water ? 1 : 0,
    );
    this.host.setQuery(
      "is_swimming",
      flags.swimming || flags.is_swimming ? 1 : 0,
    );
    this.host.setQuery(
      "is_sleeping",
      flags.sleeping || flags.is_sleeping ? 1 : 0,
    );
    this.host.setQuery("is_baby", flags.baby || flags.is_baby ? 1 : 0);
    this.host.setQuery("is_alive", 1);
    this.host.setQuery("property", (args: MolangValue[]) => {
      const key = typeof args[0] === "string" ? args[0].toLowerCase() : "";
      if (!key) return 0;
      for (const [k, v] of Object.entries(ent.props)) {
        if (k.toLowerCase() !== key) continue;
        if (typeof v === "boolean") return v ? 1 : 0;
        return v;
      }
      return 0;
    });
  }

  /** Start controllers referenced from scripts.animate / short-name map. */
  private bootControllers(): void {
    for (const entry of this.bindings.scripts.animate) {
      this.tryBootController(entry.name);
    }
  }

  /**
   * @param shortName - Entity animations short name.
   */
  private tryBootController(shortName: string): void {
    const full = this.bindings.shortNames[shortName];
    if (!full) return;
    const def = this.bindings.controllers.get(full);
    if (!def || this.controllers.has(full)) return;
    this.controllers.set(full, {
      def,
      state: def.initialState,
      blendFrom: null,
      blendT: 0,
      blendDuration: 0,
      playheads: new Map(),
    });
    this.stateLog.push(`${full}:${def.initialState}`);
  }

  /**
   * @param shortName - Short name from scripts.animate.
   * @param weight - Blend weight.
   */
  private ensureRootPlay(shortName: string, weight: number): void {
    const full = this.bindings.shortNames[shortName] ?? shortName;
    // Controllers are ticked separately.
    if (this.bindings.controllers.has(full)) {
      this.tryBootController(shortName);
      return;
    }
    const anim =
      this.bindings.animations.get(full) ??
      this.bindings.animations.get(shortName);
    if (!anim) return;
    let play = this.rootPlay.get(shortName);
    if (!play) {
      const delay = anim.startDelay
        ? asNumber(this.evalNumber(anim.startDelay))
        : 0;
      play = {
        shortName,
        anim,
        animTime: 0,
        delayLeft: delay,
        weight,
      };
      this.rootPlay.set(shortName, play);
    } else {
      play.weight = weight;
    }
  }

  /**
   * @param delta - dt.
   */
  private tickControllers(delta: number): void {
    for (const [id, inst] of this.controllers) {
      // Blend clock.
      if (inst.blendFrom && inst.blendDuration > 0) {
        inst.blendT += delta;
        if (inst.blendT >= inst.blendDuration) {
          inst.blendFrom = null;
          inst.blendT = 0;
          inst.blendDuration = 0;
        }
      }

      const state = inst.def.states.get(inst.state);
      if (!state) continue;

      // State variables (remap curves) → variable.<name>
      for (const [vName, vDef] of Object.entries(state.variables)) {
        const input = this.evalNumber(vDef.input);
        const mapped = remapCurve(asNumber(input), vDef.remapCurve);
        this.host.setVariable(vName.toLowerCase(), mapped);
      }

      // all/any_animations_finished for this state's anims.
      let allFinished = true;
      let anyFinished = false;
      let hasNonLoop = false;
      for (const ref of state.animations) {
        const anim = this.resolveAnim(ref.name);
        if (!anim || anim.loop === true) continue;
        hasNonLoop = true;
        const head = inst.playheads.get(ref.name);
        const t = head?.animTime ?? 0;
        const fin = isAnimationFinished(anim, t);
        if (fin) anyFinished = true;
        else allFinished = false;
      }
      if (!hasNonLoop) {
        allFinished = false;
        anyFinished = false;
      }
      this.host.setQuery("all_animations_finished", allFinished ? 1 : 0);
      this.host.setQuery("any_animation_finished", anyFinished ? 1 : 0);

      // One transition per frame (MS Learn).
      for (const tr of state.transitions) {
        if (!isTruthy(this.evalNumber(tr.condition))) continue;
        if (!inst.def.states.has(tr.target) || tr.target === inst.state) break;
        const leaveBlend = state.blendTransition;
        if (leaveBlend > 0) {
          inst.blendFrom = inst.state;
          inst.blendT = 0;
          inst.blendDuration = leaveBlend;
        } else {
          inst.blendFrom = null;
          inst.blendDuration = 0;
        }
        inst.state = tr.target;
        this.stateLog.push(`${id}:${tr.target}`);
        break;
      }
    }
  }

  /**
   * Advance anim_time on all playheads.
   *
   * @param delta - dt.
   */
  private advancePlayheads(delta: number): void {
    this.host.setQuery("delta_time", delta);

    for (const play of this.rootPlay.values()) {
      if (play.controllerId) continue;
      this.advanceOne(play, delta);
    }

    for (const inst of this.controllers.values()) {
      const states: string[] = [inst.state];
      if (inst.blendFrom) states.push(inst.blendFrom);
      for (const stateName of states) {
        const state = inst.def.states.get(stateName);
        if (!state) continue;
        for (const ref of state.animations) {
          const anim = this.resolveAnim(ref.name);
          if (!anim) continue;
          let head = inst.playheads.get(ref.name);
          if (!head) {
            const delay = anim.startDelay
              ? asNumber(this.evalNumber(anim.startDelay))
              : 0;
            head = { animTime: 0, delayLeft: delay };
            inst.playheads.set(ref.name, head);
          }
          if (head.delayLeft > 0) {
            head.delayLeft -= delta;
            continue;
          }
          this.host.setQuery("anim_time", head.animTime);
          head.animTime = advanceAnimTime(anim, head.animTime, this.host);
        }
      }
    }
  }

  /**
   * @param play - Root play.
   * @param delta - dt.
   */
  private advanceOne(play: PlayingAnim, delta: number): void {
    if (play.delayLeft > 0) {
      play.delayLeft -= delta;
      return;
    }
    this.host.setQuery("anim_time", play.animTime);
    this.host.setQuery("delta_time", delta);
    play.animTime = advanceAnimTime(play.anim, play.animTime, this.host);
  }

  /**
   * @param poses - Accumulator.
   */
  private sampleAll(poses: Map<string, BoneAnimPose>): void {
    for (const play of this.rootPlay.values()) {
      if (play.controllerId) continue;
      if (play.delayLeft > 0) continue;
      let w = play.weight;
      if (play.anim.blendWeight) {
        this.host.setQuery("anim_time", play.animTime);
        w *= asNumber(this.evalNumber(play.anim.blendWeight));
      }
      this.host.setQuery("anim_time", play.animTime);
      sampleAnimation(play.anim, play.animTime, w, this.host, poses);
    }

    for (const inst of this.controllers.values()) {
      const blendAlpha =
        inst.blendFrom && inst.blendDuration > 0
          ? Math.min(1, inst.blendT / inst.blendDuration)
          : 1;
      this.sampleControllerState(inst, inst.state, blendAlpha, poses);
      if (inst.blendFrom) {
        this.sampleControllerState(inst, inst.blendFrom, 1 - blendAlpha, poses);
      }
    }
  }

  /**
   * @param inst - Controller instance.
   * @param stateName - State to sample.
   * @param stateWeight - Cross-fade weight.
   * @param poses - Accumulator.
   */
  private sampleControllerState(
    inst: ControllerInst,
    stateName: string,
    stateWeight: number,
    poses: Map<string, BoneAnimPose>,
  ): void {
    if (stateWeight <= 0) return;
    const state = inst.def.states.get(stateName);
    if (!state) return;
    for (const ref of state.animations) {
      const anim = this.resolveAnim(ref.name);
      if (!anim) continue;
      const head = inst.playheads.get(ref.name);
      if (!head || head.delayLeft > 0) continue;
      let w = stateWeight;
      if (ref.weight) w *= asNumber(this.evalNumber(ref.weight));
      if (anim.blendWeight) {
        this.host.setQuery("anim_time", head.animTime);
        w *= asNumber(this.evalNumber(anim.blendWeight));
      }
      this.host.setQuery("anim_time", head.animTime);
      sampleAnimation(anim, head.animTime, w, this.host, poses);
    }
  }

  /**
   * @param shortName - Short or full animation name.
   * @returns animation or undefined.
   */
  private resolveAnim(shortName: string): ParsedAnimation | undefined {
    const full = this.bindings.shortNames[shortName] ?? shortName;
    return (
      this.bindings.animations.get(full) ??
      this.bindings.animations.get(shortName)
    );
  }

  /**
   * @param list - Molang statements.
   */
  private runScriptList(list: string[]): void {
    for (const src of list) {
      if (!src) continue;
      try {
        evaluate(src, this.host);
      } catch {
        // Malformed script — skip (pack authoring errors shouldn't kill render).
      }
    }
  }

  /**
   * @param src - Molang.
   * @returns numeric/string result.
   */
  private evalNumber(src: string): MolangValue {
    try {
      return evaluate(src, this.host);
    } catch {
      return 0;
    }
  }
}

/**
 * Build bindings from a client entity's short-name map + pack registries.
 *
 * @param shortNames - description.animations.
 * @param scripts - description.scripts.
 * @param animations - Pack animations by full id.
 * @param controllers - Pack controllers by full id.
 * @returns bindings.
 */
export function buildAnimationBindings(
  shortNames: Record<string, string>,
  scripts: ClientEntityScripts,
  animations: Map<string, ParsedAnimation>,
  controllers: Map<string, ParsedAnimController>,
): AnimationBindings {
  return {
    animations,
    controllers,
    shortNames: { ...shortNames },
    scripts,
  };
}

/**
 * Remap `input` through a piecewise-linear curve.
 *
 * @param input - Source value.
 * @param curve - Sorted knots.
 * @returns remapped value (identity when curve empty).
 */
export function remapCurve(
  input: number,
  curve: Array<{ in: number; out: number }>,
): number {
  if (curve.length === 0) return input;
  if (input <= curve[0]!.in) return curve[0]!.out;
  const last = curve[curve.length - 1]!;
  if (input >= last.in) return last.out;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i]!;
    const b = curve[i + 1]!;
    if (input > b.in) continue;
    const span = b.in - a.in;
    const u = span > 0 ? (input - a.in) / span : 1;
    return a.out + (b.out - a.out) * u;
  }
  return last.out;
}

/** @internal empty pose export for tests */
export { emptyBonePose };
