import fs from 'node:fs';
import { parse } from 'yaml';
import { compileModel } from '../src/engine/compile.ts';
import { FoldSim } from '../src/engine/sim.ts';
import { loadBases } from './lib.ts';
for (const file of process.argv.slice(2)) {
  const m = compileModel(parse(fs.readFileSync(file, 'utf8')), loadBases());
  const t0 = performance.now();
  const sim = new FoldSim(m, { facet: Number(process.env.FACET ?? 0.7), crease: Number(process.env.CREASE ?? 0.7) });
  const t1 = performance.now();
  sim.stateAt(m.steps.length, Number(process.env.Q ?? 1));
  const t2 = performance.now();
  const meas = sim.solvers.map((s) => s.measure());
  let err = 0, n = 0;
  sim.solvers.forEach((s, i) => s.target.forEach((t, h) => { if (sim.meshes[i].hingeCrease[h]) { err = Math.max(err, Math.abs(meas[i][h] - t)); n++; } }));
  console.log(file, 'verts', sim.meshes.map((x) => x.n).join('+'), 'hinges', n, 'build', (t1 - t0).toFixed(0), 'ms', 'solve', (t2 - t1).toFixed(0), 'ms', 'max angle err', err.toFixed(3));
}
