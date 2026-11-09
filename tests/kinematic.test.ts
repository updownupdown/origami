import fs from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { compileModel } from '../src/engine/compile.ts';
import { FoldSim } from '../src/engine/sim.ts';
import { Kinematics, crossings, lift } from '../src/engine/kinematic.ts';
import { loadBases } from '../scripts/lib.ts';

// Litmus tests for the step display: linked folds must move smoothly, stay symmetric and never pass paper through paper.
const bases = loadBases();
const load = (path: string) => {
  const m = compileModel(parse(fs.readFileSync(path, 'utf8')), bases);
  const sim = new FoldSim(m);
  const kin = new Kinematics(m, sim.meshes, sim.angles as any, sim.meshes.map((_, i) => sim.creaseBorn(i)));
  return { m, kin, mesh: sim.meshes[0] };
};

describe('kinematic steps', () => {
  const { m, kin, mesh } = load('models/boxes/masu-box.yaml');
  // Left-right mirror of the square sheet, as a vertex map.
  const M = lift(m.steps[0].phases[0].faces[0].a);
  const sh = m.sheets[0];
  const toW = (x: number, y: number) => [M[0] * x + M[1] * y + M[9], M[3] * x + M[4] * y + M[10]];
  const toP = (X: number, Y: number) => { const dx = X - M[9], dy = Y - M[10]; return [M[0] * dx + M[3] * dy, M[1] * dx + M[4] * dy]; };
  const cw = toW(sh.w / 2, sh.h / 2);
  const mirror = Array.from({ length: mesh.n }, (_, i) => {
    const w = toW(mesh.paper[2 * i], mesh.paper[2 * i + 1]);
    const p = toP(2 * cw[0] - w[0], w[1]);
    let best = -1, bd = Infinity;
    for (let j = 0; j < mesh.n; j++) { const d = Math.hypot(mesh.paper[2 * j] - p[0], mesh.paper[2 * j + 1] - p[1]); if (d < bd) { bd = d; best = j; } }
    return bd < 1e-3 ? best : -1;
  });

  for (const step of [7, 8, 9]) {
    it(`masu step ${step} folds without crossings, jumps or lopsidedness`, () => {
      const s = step - 1;
      kin.ensureStep(s);
      expect(kin.tier[s]).not.toBe('crossing');
      expect(kin.spans[s]).toEqual([]);
      let prev: Float64Array | null = null, asym = 0, jump = 0;
      for (const F of kin.frames[s]!) {
        const P = kin.positions(0, F.X[0]);
        expect(crossings(mesh, P).length).toBe(0);
        if (prev) for (let i = 0; i < P.length; i++) jump = Math.max(jump, Math.abs(P[i] - prev[i]));
        prev = P;
        let c = 0, n = 0;
        for (let i = 0; i < mesh.n; i++) if (mirror[i] >= 0) { c += (P[3 * i] + P[3 * mirror[i]]) / 2; n++; }
        c /= n;
        for (let i = 0; i < mesh.n; i++) {
          const j = mirror[i]; if (j < 0) continue;
          asym = Math.max(asym, Math.hypot(2 * c - P[3 * i] - P[3 * j], P[3 * i + 1] - P[3 * j + 1], P[3 * i + 2] - P[3 * j + 2]));
        }
      }
      expect(asym / sh.w).toBeLessThan(1e-4);
      // No vertex moves more than a fifth of the sheet between samples.
      expect(jump / sh.w).toBeLessThan(0.2);
    }, 30000);
  }

  it('faces that fold flat onto each other in 3D are stacked apart (no flicker)', () => {
    kin.ensureStep(7);
    const end = kin.stacks[7]!.at(-1)![0];
    expect(end.some((x) => x !== 0)).toBe(true);
  });

  it('the swan finishes clean and on target', () => {
    const { m, kin, mesh } = load('models/animals/swan.yaml');
    const last = m.steps.length - 1;
    for (let s = 0; s <= last; s++) kin.ensureStep(s);
    for (let s = 0; s <= last; s++) expect(kin.tier[s] ?? 'exact').not.toBe('crossing');
    const end = kin.frames[last]!.at(-1)!;
    expect(crossings(mesh, kin.positions(0, end.X[0])).length).toBe(0);
  }, 60000);
});
