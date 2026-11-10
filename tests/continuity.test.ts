import { describe, expect, it } from 'vitest';
import { compileModel } from '../src/engine/compile.ts';
import { FoldSim } from '../src/engine/sim.ts';
import { Kinematics } from '../src/engine/kinematic.ts';
import { loadBases, loadModels } from '../scripts/lib.ts';

// Every step starts exactly where the step before it ended: the same stored state gives the same
// pose and the same paper thickness, whichever way the step is shown.
const bases = loadBases();
const models = loadModels().filter((m) => m.script.kind !== 'base' && !m.file.includes('/drafts/'));

describe('step continuity', () => {
  for (const { script } of models) {
    it(`${script.id}: each step starts where the last one ended`, () => {
      const m = compileModel(script, bases);
      const sim = new FoldSim(m);
      const kin = new Kinematics(m, sim.meshes, sim.angles as any, sim.meshes.map((_, i) => sim.creaseBorn(i)));
      const size = m.extent;
      let seam = 0, level = 0, tilt = 0;
      let prevX: Float64Array[] | null = null, prevL: Float32Array[] | null = null, prevTilt: number | null = null;
      for (let s = 0; s < m.steps.length; s++) {
        kin.ensureStep(s);
        const F = kin.frames[s]!, L = kin.levels[s]!;
        if (prevX) F[0].X.forEach((X, si) => {
          const a = kin.positions(si, X), b = kin.positions(si, prevX![si]);
          for (let i = 0; i < a.length; i++) seam = Math.max(seam, Math.abs(a[i] - b[i]));
        });
        if (prevL) L[0].forEach((x, si) => x.forEach((v, f) => (level = Math.max(level, Math.abs(v - prevL![si][f])))));
        const phases = m.steps[s].phases;
        if (phases.length) {
          const t0 = phases[0].tilt?.a0 ?? 0;
          if (prevTilt !== null) tilt = Math.max(tilt, Math.abs(t0 - prevTilt));
          prevTilt = phases.at(-1)!.tilt?.a1 ?? 0;
        }
        prevX = F.at(-1)!.X;
        prevL = L.at(-1)!;
      }
      // Compiled transforms are rounded to 1e-6 cm, so allow a hair more than that.
      expect(seam / size).toBeLessThan(1e-5);
      expect(level).toBe(0);
      expect(tilt).toBeLessThan(1e-9);
    }, 120000);
  }
});
