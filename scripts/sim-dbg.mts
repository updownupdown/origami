import fs from 'node:fs';
import { parse } from 'yaml';
import { compileModel } from '../src/engine/compile.ts';
import { FoldSim } from '../src/engine/sim.ts';
import { loadBases } from './lib.ts';
const m = compileModel(parse(fs.readFileSync(process.argv[2], 'utf8')), loadBases());
const sim = new FoldSim(m);
for (let s = 0; s <= m.steps.length; s++) {
  sim.stateAt(s);
  sim.setRestTargets(s);
  const sv = sim.solvers[0], me = sim.meshes[0];
  const meas = sv.measure();
  const rows: string[] = [];
  for (let h = 0; h < me.hingeCrease.length; h++) if (me.hingeCrease[h]) {
    const a = me.hinges[4 * h], b = me.hinges[4 * h + 1];
    rows.push(`[${me.paper[2*a].toFixed(1)},${me.paper[2*a+1].toFixed(1)}-${me.paper[2*b].toFixed(1)},${me.paper[2*b+1].toFixed(1)}] t=${(sv.target[h]*180/Math.PI).toFixed(0)} m=${(meas[h]*180/Math.PI).toFixed(0)}`);
  }
  console.log(`after ${s} steps:`, rows.join('  '));
}
