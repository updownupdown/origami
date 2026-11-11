import { describe, expect, it } from 'vitest';
import { compileModel } from '../src/engine/compile.ts';
import { FoldSim } from '../src/engine/sim.ts';
import { Kinematics } from '../src/engine/kinematic.ts';
import { loadBases, loadModels } from '../scripts/lib.ts';

// `refold`: several creases of an already folded sheet change at once and the sheet is flat again
// afterwards (a squash fold, a petal fold, a page turned, a reverse fold). The lily is built from
// them: four squashes and four petal folds make the frog base, and four reverse folds the petals.
const bases = loadBases();
const lily = loadModels().find((m) => m.script.id === 'lily')!.script;
const build = (script: any) => {
  const m = compileModel(script, bases);
  const sim = new FoldSim(m);
  return { m, sim, kin: new Kinematics(m, sim.meshes, sim.angles as any, sim.meshes.map((_, i) => sim.creaseBorn(i))) };
};
const head = { id: 't', title: 'T', materials: [{ id: 'paper', size: 15, diamond: true }] };
const squash = {
  text: 'Squash',
  points: { P1: 'bisect(O mid(B C) C)', P2: 'bisect(O mid(B C) B)' },
  refold: { valley: [['O', 'C']], mountain: [['O', 'P1']], fold: [['O', 'P2']], flatten: [['O', 'mid(B C)']] },
};
const deg = (r: number) => (r * 180) / Math.PI;

/** Fold angles (degrees, at the end of step s) of the creases on a segment of the unfolded sheet. */
function anglesOn(sim: FoldSim, s: number, a: [number, number], b: [number, number]): number[] {
  const mesh = sim.meshes[0], A = sim.angles[s].at(-1)!, out: number[] = [];
  const on = (i: number) => {
    const x = mesh.paper[2 * i], y = mesh.paper[2 * i + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    const t = ((x - a[0]) * dx + (y - a[1]) * dy) / L2;
    return t > -1e-6 && t < 1 + 1e-6 && Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y) < 1e-5;
  };
  for (let h = 0; h < mesh.hingeCrease.length; h++) {
    if (mesh.hingeCrease[h] && on(mesh.hinges[4 * h]) && on(mesh.hinges[4 * h + 1])) out.push(deg(A.b[0][h]));
  }
  return out;
}

describe('refold: squash, petal and reverse folds on a folded sheet', () => {
  it('squashes a flap of the preliminary base flat, moving rigidly', () => {
    const { m, sim, kin } = build({ ...head, steps: [{ use: 'base/preliminary' }, squash] });
    const s = m.steps.length - 1;
    expect(m.steps[s].phases.map((p) => p.motion)).toEqual(['refold']);
    kin.ensureStep(s);
    expect(kin.missed[s]).toBeLessThan(0.05);
    expect(kin.crossed[s]).toBe(0);
    expect(kin.tier[s]).toBe('kinematic');
    // Of the four creases from the centre to the middle of an edge, the squashed one now lies open.
    const mids: [number, number][] = [[15, 7.5], [7.5, 15], [0, 7.5], [7.5, 0]];
    const open = mids.filter((p) => anglesOn(sim, s, [7.5, 7.5], p).every((v) => Math.abs(v) < 1e-6));
    expect(open.length).toBe(1);
    // Every crease is open or folded flat again.
    const A = sim.angles[s][0].b[0];
    for (let h = 0; h < A.length; h++) if (sim.meshes[0].hingeCrease[h]) expect([0, 180]).toContain(Math.round(Math.abs(deg(A[h]))));
  }, 60_000);

  it('says so when the creases cannot fold flat, or name no crease', () => {
    const one = (refold: any) => () => compileModel({ ...head, steps: [{ use: 'base/preliminary' }, { ...squash, refold }] } as any, bases);
    expect(one({ valley: [['O', 'P1']] })).toThrow(/do not fold flat/);
    expect(one({ flatten: [['O', 'P1']] })).toThrow(/no crease|not folded/);
    expect(one({ valley: [['O', 'mid(B C)']] })).toThrow(/already folded/);
  });

  const { m, sim, kin } = build(lily);
  it('lily: every step is reached exactly and no step ends with paper through paper', () => {
    m.steps.forEach((_, s) => {
      kin.ensureStep(s);
      expect(kin.missed[s], `step ${s + 1}`).toBeLessThan(0.05);
    });
    // The squashes, petal folds and page turns move rigidly; only the reverse folds are staged.
    const staged = m.steps.map((_, s) => s).filter((s) => kin.tier[s] === 'crossing');
    for (const s of staged) expect(m.steps[s].phases.some((p) => p.name === 'tips'), `step ${s + 1}`).toBe(true);
  }, 120_000);

  it('lily: the flower opens into four equal petals around its axis', () => {
    const s = m.steps.findIndex((st) => st.phases.some((p) => p.motion === 'shape'));
    kin.ensureStep(s);
    expect(kin.tier[s]).toBe('kinematic');
    expect(kin.crossed[s]).toBe(0);
    const mesh = sim.meshes[0], P = kin.positions(0, kin.frames[s]!.at(-1)!.X[0]);
    const at = (x: number, y: number) => {
      for (let i = 0; i < mesh.n; i++) if (Math.hypot(mesh.paper[2 * i] - x, mesh.paper[2 * i + 1] - y) < 1e-5) return [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
      throw new Error(`no vertex at ${x}, ${y}`);
    };
    const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const O = at(7.5, 7.5), tips = [at(0, 0), at(15, 0), at(15, 15), at(0, 15)];
    const side = tips.map((t, i) => d(t, tips[(i + 1) % 4]));
    for (const v of side) expect(v).toBeCloseTo(side[0], 2);
    expect(d(tips[0], tips[2])).toBeCloseTo(side[0] * Math.SQRT2, 2);
    expect(d(tips[1], tips[3])).toBeCloseTo(side[0] * Math.SQRT2, 2);
    // Each petal tip leans out from the axis by the angle its reverse fold gives (about 84 degrees).
    const c = [0, 1, 2].map((k) => (tips[0][k] + tips[1][k] + tips[2][k] + tips[3][k]) / 4);
    const ax = c.map((v, k) => v - O[k]), L = Math.hypot(...ax);
    const bends: [number, number][] = [[3, 3], [12, 3], [12, 12], [3, 12]];
    const want = 2 * deg(Math.atan(Math.SQRT1_2 * Math.tan((52 * Math.PI) / 180)));
    tips.forEach((t, i) => {
      const X = at(...bends[i]), v = t.map((x, k) => x - X[k]);
      const lean = deg(Math.acos((v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2]) / (L * Math.hypot(...v))));
      expect(lean).toBeCloseTo(want, 1);
    });
    // The body: each petal's centre crease stands at a right angle, below and above its bend.
    for (const k of [[0, 0], [15, 0], [15, 15], [0, 15]] as [number, number][]) {
      const a = anglesOn(sim, s, [7.5, 7.5], k).map((v) => Math.round(Math.abs(v)));
      expect(a.length).toBeGreaterThan(1);
      expect(new Set(a)).toEqual(new Set([90]));
    }
  }, 120_000);
});
