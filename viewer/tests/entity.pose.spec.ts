/**
 * Bone pose application specs — the pivot regression behind the scrambled
 * player / Bulbasaur renders: animation and head-pitch rotations must spin a
 * bone around its own pivot, never the model origin.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import {
  addLocomotionPoses,
  applyBonePoses,
  applyHeadPitch,
  buildEntityModel,
  classifyLimb,
  createLocomotion,
  emptyBonePose,
  tickLocomotion,
  type BoneAnimPose,
} from "../src/entity";
import {
  computeBoneWorldMatrices,
  parseGeometryDocument,
  type ParsedGeometry,
} from "../src/geometry";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "testdata", "entity");

function loadGeometry(): ParsedGeometry {
  const json = JSON.parse(
    readFileSync(join(fixtures, "blocky.geo.json"), "utf8"),
  );
  return parseGeometryDocument(json).geometries[0]!;
}

function buildModel(geometry: ParsedGeometry) {
  return buildEntityModel({ geometry, texture: new THREE.Texture() });
}

/**
 * @param m - Matrix.
 * @param p - Point.
 * @returns transformed point triple.
 */
function apply(m: THREE.Matrix4, p: [number, number, number]) {
  const v = new THREE.Vector3(...p).applyMatrix4(m);
  return [v.x, v.y, v.z] as const;
}

test.describe("applyBonePoses (pivot correctness)", () => {
  test("rotation spins the bone about its pivot, not the origin", () => {
    const geometry = loadGeometry();
    const model = buildModel(geometry);
    const poses = new Map<string, BoneAnimPose>();
    const head = emptyBonePose();
    head.rotation = [90, 0, 0];
    poses.set("head", head);

    applyBonePoses(model.bones, poses);
    model.root.updateMatrixWorld(true);

    const world = model.bones.get("head")!.matrixWorld;
    // Head pivot bedrock [0,16,0] → three [0,1,0] must stay fixed.
    const pivot = apply(world, [0, 1, 0]);
    expect(pivot[0]).toBeCloseTo(0, 5);
    expect(pivot[1]).toBeCloseTo(1, 5);
    expect(pivot[2]).toBeCloseTo(0, 5);
    // Point 6 units above the pivot swings to 6 units +Z (bedrock R_x(90°)).
    const top = apply(world, [0, 1 + 6 / 16, 0]);
    expect(top[1]).toBeCloseTo(1, 5);
    expect(top[2]).toBeCloseTo(6 / 16, 5);
    model.dispose();
  });

  test("matches computeBoneWorldMatrices for a combined pose", () => {
    const geometry = loadGeometry();
    const model = buildModel(geometry);
    const poses = new Map<string, BoneAnimPose>();
    poses.set("body", {
      position: [0, 0, 0],
      rotation: [0, 45, 0],
      scale: [1, 1, 1],
      override: false,
    });
    poses.set("head", {
      position: [1, 2, 3],
      rotation: [30, 0, 10],
      scale: [1, 1, 1],
      override: false,
    });

    applyBonePoses(model.bones, poses);
    model.root.updateMatrixWorld(true);

    const expected = computeBoneWorldMatrices(geometry, {
      body: { rotation: [0, 45, 0] },
      head: { rotation: [30, 0, 10], position: [1, 2, 3] },
    });
    for (const bone of ["body", "head"]) {
      const got = model.bones.get(bone)!.matrixWorld.elements;
      const want = expected.get(bone)!.elements;
      for (let i = 0; i < 16; i++) {
        expect(got[i]!, `${bone}[${i}]`).toBeCloseTo(want[i]!, 5);
      }
    }
    model.dispose();
  });

  test("applyHeadPitch keeps the head pivot fixed", () => {
    const geometry = loadGeometry();
    const model = buildModel(geometry);

    applyHeadPitch(model.bones, 50);
    model.root.updateMatrixWorld(true);

    const world = model.bones.get("head")!.matrixWorld;
    const pivot = apply(world, [0, 1, 0]);
    expect(pivot[0]).toBeCloseTo(0, 5);
    expect(pivot[1]).toBeCloseTo(1, 5);
    expect(pivot[2]).toBeCloseTo(0, 5);
    model.dispose();
  });

  test("empty pose reproduces the rest matrix exactly", () => {
    const geometry = loadGeometry();
    const model = buildModel(geometry);
    const rest = new Map(
      [...model.bones].map(([n, g]) => [n, g.matrix.clone()]),
    );

    applyBonePoses(model.bones, new Map());
    for (const [name, g] of model.bones) {
      const want = rest.get(name)!.elements;
      for (let i = 0; i < 16; i++) {
        expect(g.matrix.elements[i]!, `${name}[${i}]`).toBeCloseTo(want[i]!, 6);
      }
    }
    model.dispose();
  });
});

test.describe("procedural locomotion", () => {
  test("classifyLimb matches common bone names", () => {
    expect(classifyLimb("leftArm")).toMatchObject({
      kind: "arm",
      side: "left",
    });
    expect(classifyLimb("rightArm")).toMatchObject({
      kind: "arm",
      side: "right",
    });
    expect(classifyLimb("left_leg")).toMatchObject({
      kind: "leg",
      side: "left",
    });
    expect(classifyLimb("RightLeg")).toMatchObject({
      kind: "leg",
      side: "right",
    });
    // Vanilla quadruped: leg0..leg3; diagonal pairs share a phase sign.
    const l0 = classifyLimb("leg0")!;
    const l1 = classifyLimb("leg1")!;
    const l2 = classifyLimb("leg2")!;
    const l3 = classifyLimb("leg3")!;
    expect(l0.phaseSign).toBe(l3.phaseSign);
    expect(l1.phaseSign).toBe(l2.phaseSign);
    expect(l0.phaseSign).not.toBe(l1.phaseSign);
    // Named quadruped legs.
    const fl = classifyLimb("leftFrontLeg")!;
    const br = classifyLimb("rightBackLeg")!;
    const fr = classifyLimb("rightFrontLeg")!;
    expect(fl.phaseSign).toBe(br.phaseSign);
    expect(fl.phaseSign).not.toBe(fr.phaseSign);
    // Non-limbs.
    expect(classifyLimb("head")).toBeNull();
    expect(classifyLimb("body")).toBeNull();
    expect(classifyLimb("leftArmor")).toBeNull();
  });

  test("walking swings arms and legs in opposite phase; idle decays", () => {
    const st = createLocomotion();
    // Walk at 2 blocks/s for a while.
    for (let i = 0; i < 30; i++) tickLocomotion(st, 0.05, 2, 0);
    expect(st.amp).toBeGreaterThan(0.9);

    // Sample a phase where sin() is non-zero.
    st.phase = Math.PI / 2;
    const poses = new Map<string, BoneAnimPose>();
    addLocomotionPoses(
      st,
      ["leftArm", "rightArm", "leftLeg", "rightLeg", "head"],
      poses,
    );
    const la = poses.get("leftArm")!.rotation[0];
    const ra = poses.get("rightArm")!.rotation[0];
    const ll = poses.get("leftLeg")!.rotation[0];
    const rl = poses.get("rightLeg")!.rotation[0];
    expect(poses.has("head")).toBe(false);
    expect(ll).toBeGreaterThan(10);
    expect(Math.sign(ll)).toBe(-Math.sign(rl));
    expect(Math.sign(la)).toBe(-Math.sign(ra));
    expect(Math.sign(la)).toBe(-Math.sign(ll)); // arm opposes same-side leg

    // Stopping eases amplitude back to zero.
    for (let i = 0; i < 60; i++) tickLocomotion(st, 0.05, 0, 0);
    expect(st.amp).toBe(0);
    const idle = new Map<string, BoneAnimPose>();
    addLocomotionPoses(st, ["leftLeg"], idle);
    expect(idle.size).toBe(0);
  });

  test("pack-animated bones are left alone", () => {
    const st = createLocomotion();
    for (let i = 0; i < 30; i++) tickLocomotion(st, 0.05, 2, 0);
    st.phase = Math.PI / 2;
    const poses = new Map<string, BoneAnimPose>();
    const packDriven = emptyBonePose();
    packDriven.rotation = [5, 0, 0];
    poses.set("leftLeg", packDriven);
    addLocomotionPoses(st, ["leftLeg", "rightLeg"], poses);
    expect(poses.get("leftLeg")!.rotation[0]).toBe(5);
    expect(Math.abs(poses.get("rightLeg")!.rotation[0])).toBeGreaterThan(10);
  });

  test("swing counter triggers a one-shot arm swing on the right arm", () => {
    const st = createLocomotion();
    // First observation seeds without swinging.
    tickLocomotion(st, 0.05, 0, 3);
    let poses = new Map<string, BoneAnimPose>();
    addLocomotionPoses(st, ["leftArm", "rightArm"], poses);
    expect(poses.size).toBe(0);

    // Counter bump → swing starts.
    tickLocomotion(st, 0.05, 0, 4);
    tickLocomotion(st, 0.1, 0, 4); // mid-swing
    poses = new Map();
    addLocomotionPoses(st, ["leftArm", "rightArm"], poses);
    expect(poses.has("leftArm")).toBe(false);
    expect(Math.abs(poses.get("rightArm")!.rotation[0])).toBeGreaterThan(20);

    // Swing expires.
    for (let i = 0; i < 10; i++) tickLocomotion(st, 0.1, 0, 4);
    poses = new Map();
    addLocomotionPoses(st, ["leftArm", "rightArm"], poses);
    expect(poses.size).toBe(0);
  });
});
