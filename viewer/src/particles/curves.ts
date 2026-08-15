import type { MolangHost } from "../molang";
import { evalExpr } from "./expr";
import type { ParticleCurve } from "./types";

/**
 * Evaluate a particle curve at the current host state.
 *
 * linear + catmull_rom are exact; bezier uses cubic Bernstein on ≤4 nodes
 * (extra nodes ignored); bezier_chain hermite-interpolates keyed value/slope
 * pairs. Unknown types return 0.
 *
 * @param curve - Parsed curve.
 * @param host - Host with particle/emitter variables set.
 * @returns curve sample.
 */
export function evaluateCurve(curve: ParticleCurve, host: MolangHost): number {
  const input = evalExpr(curve.input, host);
  const range = Math.max(1e-6, evalExpr(curve.horizontalRange, host));
  const t = clamp01(input / range);

  switch (curve.type) {
    case "linear":
      return sampleLinear(curve.nodes, t);
    case "catmull_rom":
      return sampleCatmullRom(curve.nodes, t);
    case "bezier":
      return sampleBezier(curve.nodes, t);
    case "bezier_chain":
      return sampleBezierChain(curve.chainNodes, t);
    default:
      return 0;
  }
}

/**
 * Apply every curve, writing results into `variable.<name>` on the host.
 *
 * @param curves - Effect curves.
 * @param host - Mutable host.
 */
export function applyCurves(curves: ParticleCurve[], host: MolangHost): void {
  for (const c of curves) {
    host.setVariable(c.name, evaluateCurve(c, host));
  }
}

function clamp01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

function sampleLinear(nodes: number[], t: number): number {
  if (nodes.length === 0) return 0;
  if (nodes.length === 1) return nodes[0]!;
  const x = t * (nodes.length - 1);
  const i = Math.min(nodes.length - 2, Math.floor(x));
  const f = x - i;
  return nodes[i]! * (1 - f) + nodes[i + 1]! * f;
}

/** Centripetal-ish uniform Catmull-Rom through nodes (endpoints clamped). */
function sampleCatmullRom(nodes: number[], t: number): number {
  if (nodes.length === 0) return 0;
  if (nodes.length === 1) return nodes[0]!;
  if (nodes.length === 2) return sampleLinear(nodes, t);
  const x = t * (nodes.length - 1);
  const i = Math.min(nodes.length - 2, Math.floor(x));
  const f = x - i;
  const p0 = nodes[Math.max(0, i - 1)]!;
  const p1 = nodes[i]!;
  const p2 = nodes[i + 1]!;
  const p3 = nodes[Math.min(nodes.length - 1, i + 2)]!;
  const f2 = f * f;
  const f3 = f2 * f;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * f +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * f3)
  );
}

/** Cubic Bernstein on first 4 nodes (pad by repeating ends). */
function sampleBezier(nodes: number[], t: number): number {
  const p0 = nodes[0] ?? 0;
  const p1 = nodes[1] ?? p0;
  const p2 = nodes[2] ?? p1;
  const p3 = nodes[3] ?? p2;
  const u = 1 - t;
  return (
    u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
  );
}

function sampleBezierChain(
  nodes: Array<{ t: number; value: number; slope: number }>,
  t: number,
): number {
  if (nodes.length === 0) return 0;
  const sorted = nodes.slice().sort((a, b) => a.t - b.t);
  if (t <= sorted[0]!.t) return sorted[0]!.value;
  const last = sorted[sorted.length - 1]!;
  if (t >= last.t) return last.value;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (t < a.t || t > b.t) continue;
    const span = Math.max(1e-6, b.t - a.t);
    const u = (t - a.t) / span;
    // Hermite with slopes scaled by segment length (approx of Bedrock chain).
    const m0 = a.slope * span;
    const m1 = b.slope * span;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    return h00 * a.value + h10 * m0 + h01 * b.value + h11 * m1;
  }
  return last.value;
}
