import { describe, expect, it } from 'vitest';
import { compileModel } from '../src/engine/compile.ts';
import { FoldSim } from '../src/engine/sim.ts';
import { Kinematics } from '../src/engine/kinematic.ts';
import { loadBases, loadModels } from '../scripts/lib.ts';

// `pose`: a folded sheet set in place in space as one rigid piece. The potted agave is built from
// seven sheets this way: a strip curled into a seven-sided ring, and six leaves stood in it.
const bases = loadBases();
const agave = loadModels().find((m) => m.script.id === 'potted-agave')!.script;
const build = () => {
  const m = compileModel(agave, bases);
  const sim = new FoldSim(m);
  return { m, sim, kin: new Kinematics(m, sim.meshes, sim.angles as any, sim.meshes.map((_, i) => sim.creaseBorn(i))) };
};
const { m, sim, kin } = build();
const sheet = (id: string) => sim.meshes.findIndex((x) => x.sheet === id);
const span = (P: ArrayLike<number>, c: number) => {
  let lo = Infinity, hi = -Infinity;
  for (let i = c; i < P.length; i += 3) { lo = Math.min(lo, P[i]); hi = Math.max(hi, P[i]); }
  return [lo, hi];
};

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Does the segment pq go through triangle abc, clear of its edges and of touching by eps (cm)? */
function pierces(p: V, q: V, a: V, b: V, c: V, eps = 0.03): boolean {
  const n = cross(sub(b, a), sub(c, a)), L = Math.hypot(...n);
  const dp = dot(sub(p, a), n) / L, dq = dot(sub(q, a), n) / L;
  if (dp * dq >= 0 || Math.abs(dp) < eps || Math.abs(dq) < eps) return false;
  const t = dp / (dp - dq), x: V = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  const inside = (u: V, v: V) => dot(cross(sub(v, u), sub(x, u)), n) / L / Math.hypot(...sub(v, u));
  return inside(a, b) > eps && inside(b, c) > eps && inside(c, a) > eps;
}

describe('pose: sheets set in place in 3D', () => {
  it('agave: the strip closes into a seven-sided ring and stands as a pot', () => {
    const s = m.steps.findIndex((st) => st.phases.some((p) => p.motion === 'shape'));
    kin.ensureStep(s);
    expect(kin.missed[s]).toBeLessThan(1e-6);
    expect(kin.crossed[s]).toBe(0);
    // Eight panels at a seventh of a turn each: the last panel lies on the first.
    const pot = sheet('pot'), mesh = sim.meshes[pot], P = kin.posAt(s, 1)[pot];
    const corner = (x: number, y: number) => {
      let best = -1, d = Infinity;
      for (let i = 0; i < mesh.n; i++) { const e = Math.hypot(mesh.paper[2 * i] - x, mesh.paper[2 * i + 1] - y); if (e < d) { d = e; best = i; } }
      return [P[3 * best], P[3 * best + 1], P[3 * best + 2]];
    };
    const [x0, x1] = span(mesh.paper, 0), [y0] = [Math.min(...Array.from({ length: mesh.n }, (_, i) => mesh.paper[2 * i + 1]))];
    const w = (x1 - x0) / 8;
    const a = corner(x0, y0), b = corner(x0 + 7 * w, y0), c = corner(x0 + w, y0), d = corner(x1, y0);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(1e-6);
    expect(Math.hypot(c[0] - d[0], c[1] - d[1], c[2] - d[2])).toBeLessThan(1e-6);
    // Stood upright it reaches from the table to the strip's width, the same all the way round.
    const up = m.steps.findIndex((st) => st.phases.some((p) => p.pose?.sheet === 'pot'));
    const [lo, hi] = span(kin.posAt(up, 1)[pot], 2);
    expect(lo).toBeCloseTo(0, 6);
    expect(hi).toBeCloseTo(5, 6);
  });

  it('agave: each leaf ends where its step puts it and stays there', () => {
    const end = kin.posAt(m.steps.length - 1, 1);
    let posed = 0;
    m.steps.forEach((st, s) => st.phases.forEach((ph, p) => {
      if (!ph.pose || ph.pose.sheet === 'pot') return;
      posed++;
      const si = sheet(ph.pose.sheet), P = kin.posAt(s, (p + 1) / st.phases.length)[si];
      // The leaf's foot is its lowest point, at the height and place asked for.
      let low = 0;
      for (let i = 0; i < P.length / 3; i++) if (P[3 * i + 2] < P[3 * low + 2]) low = i;
      for (let c = 0; c < 3; c++) expect(P[3 * low + c]).toBeCloseTo(ph.pose.to[c], 3);
      // It is still a flat-folded leaf with a shallow V: nothing stretched on the way.
      const [zl, zh] = span(P, 2);
      expect(zh - zl).toBeGreaterThan(3);
      expect(zh - zl).toBeLessThan(10.7);
      // And no later step moves it.
      let d = 0;
      for (let i = 0; i < P.length; i++) d = Math.max(d, Math.abs(P[i] - end[si][i]));
      expect(d).toBeLessThan(1e-9);
    }));
    expect(posed).toBe(6);
  });

  it('agave: a posed sheet is moved whole (every face by the same rigid motion)', () => {
    const s = m.steps.findIndex((st) => st.phases.some((p) => p.pose && p.pose.sheet !== 'pot'));
    const si = sheet(m.steps[s].phases[0].pose!.sheet), mesh = sim.meshes[si];
    const A = kin.posAt(s, 0)[si], B = kin.posAt(s, 0.5 / m.steps[s].phases.length)[si];
    // Distances between vertices are kept half way through the move.
    let worst = 0;
    for (let i = 0; i < mesh.n; i += 3) for (let j = i + 1; j < mesh.n; j += 5) {
      const da = Math.hypot(A[3 * i] - A[3 * j], A[3 * i + 1] - A[3 * j + 1], A[3 * i + 2] - A[3 * j + 2]);
      const db = Math.hypot(B[3 * i] - B[3 * j], B[3 * i + 1] - B[3 * j + 1], B[3 * i + 2] - B[3 * j + 2]);
      worst = Math.max(worst, Math.abs(da - db));
    }
    expect(worst).toBeLessThan(1e-6);
    expect(kin.rigidAt(s, 0.3)).not.toBeNull();
  });

  it('agave: in the finished plant no sheet passes through another', () => {
    const P = kin.posAt(m.steps.length - 1, 1);
    const tri = (si: number, k: number): V[] => [0, 1, 2].map((j) => { const i = sim.meshes[si].tris[3 * k + j]; return [P[si][3 * i], P[si][3 * i + 1], P[si][3 * i + 2]] as V; });
    const hits: string[] = [];
    for (let a = 0; a < sim.meshes.length; a++) for (let b = 0; b < sim.meshes.length; b++) {
      if (a === b) continue;
      const na = sim.meshes[a].tris.length / 3, nb = sim.meshes[b].tris.length / 3;
      let n = 0;
      for (let i = 0; i < na; i++) { const T = tri(a, i); for (let j = 0; j < nb; j++) { const U = tri(b, j); for (let e = 0; e < 3; e++) if (pierces(T[e], T[(e + 1) % 3], U[0], U[1], U[2])) n++; } }
      if (n) hits.push(`${sim.meshes[a].sheet} through ${sim.meshes[b].sheet}`);
    }
    expect(hits).toEqual([]);
  });

  it('agave: steps are about the sheet being folded, then about the pieces standing together', () => {
    expect(m.steps[0].sheets).toEqual(['pot']);
    const first = m.steps.findIndex((st) => st.phases.some((p) => p.pose && p.pose.sheet !== 'pot'));
    expect(m.steps[first].sheets).toEqual(['pot', 'leaf1', 'leaf2', 'leaf3']);
    expect(m.steps.at(-1)!.sheets!.length).toBe(7);
  });
});
