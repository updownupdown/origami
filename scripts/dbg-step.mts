import fs from 'node:fs';
import { parse } from 'yaml';
import { compileModel } from '../src/engine/compile.ts';
import { apply } from '../src/engine/geometry.ts';
import { loadBases } from './lib.ts';
const m = compileModel(parse(fs.readFileSync(process.argv[2], 'utf8')), loadBases());
const k = Number(process.argv[3]) - 1;
for (const f of m.steps[k].phases[0].faces) {
  const pts = []; for (let i = 0; i < f.p.length; i += 2) pts.push(apply(f.b, [f.p[i], f.p[i+1]]).map(v=>v.toFixed(2)).join(','));
  console.log(f.id, 'd', f.d, 'la', f.la, 'lb', f.lb, pts.join(' '));
}
