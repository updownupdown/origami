import { describe, expect, it } from 'vitest';
import { compileModel } from '../src/engine/compile.ts';
import { FoldSim } from '../src/engine/sim.ts';
import { Kinematics } from '../src/engine/kinematic.ts';
import { loadBases, loadModels } from '../scripts/lib.ts';

// Soft steps: shapes the paper has to bend to reach, solved as a springy mesh.
const bases = loadBases();
const crane = loadModels().find((m) => m.script.id === 'crane')!.script;
const build = () => {
  const m = compileModel(crane, bases);
  const sim = new FoldSim(m);
  return { m, sim, kin: new Kinematics(m, sim.meshes, sim.angles as any, sim.meshes.map((_, i) => sim.creaseBorn(i))) };
};

describe('soft steps', () => {
  it('crane: pulling the wings apart spreads them level, one each side', () => {
    const { m, sim, kin } = build();
    const s = m.steps.findIndex((st) => st.phases.some((p) => p.soft));
    expect(s).toBeGreaterThan(0);
    const P0 = kin.posAt(s, 0)[0], P1 = kin.posAt(s, 1)[0], mesh = sim.meshes[0];
    // The paper starts flat, and ends with a wing tip well out on each side of the body.
    let z0 = 0, hi = 0, lo = 0;
    for (let i = 0; i < mesh.n; i++) { z0 = Math.max(z0, Math.abs(P0[3 * i + 2])); hi = Math.max(hi, P1[3 * i + 2]); lo = Math.min(lo, P1[3 * i + 2]); }
    expect(z0).toBeLessThan(1e-6);
    expect(hi).toBeGreaterThan(6);
    expect(hi + lo).toBeCloseTo(0, 1);
    // The step after it (standing the crane up) keeps the bent shape.
    const Q = kin.posAt(s + 1, 1)[0];
    let d = 0;
    for (let i = 0; i < Q.length; i++) d = Math.max(d, Math.abs(Q[i] - P1[i]));
    expect(d).toBeLessThan(1e-9);
  });

  it('crane: the bent shape replays from the build-time record', () => {
    const a = build();
    const rec = JSON.parse(JSON.stringify(a.kin.record()));
    const b = build();
    b.kin.load(rec);
    const s = a.m.steps.findIndex((st) => st.phases.some((p) => p.soft));
    for (const t of [0, 0.37, 1]) {
      const A = a.kin.posAt(s, t)[0], B = b.kin.posAt(s, t)[0];
      let d = 0;
      for (let i = 0; i < A.length; i++) d = Math.max(d, Math.abs(A[i] - B[i]));
      expect(d).toBeLessThan(1e-4);
    }
  });
});
