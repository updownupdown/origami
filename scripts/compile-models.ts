// Compiles every model script in models/ into the data the site serves.
import fs from 'node:fs';
import path from 'node:path';
import { compileModel, CompileError } from '../src/engine/compile.ts';
import { toFold } from '../src/engine/fold-format.ts';
import { finalSvg } from '../src/engine/svg.ts';
import { ROOT, loadBases, loadModels } from './lib.ts';
import { buildIndex } from './index-entries.ts';

const out = (p: string) => path.join(ROOT, p);
for (const d of ['public/models', 'public/fold', 'public/thumbs', 'public/src', 'src/generated']) fs.mkdirSync(out(d), { recursive: true });

const bases = loadBases();
const compiled = [];
let failed = 0;
const ids = new Set<string>();
for (const { file, script } of loadModels()) {
  const rel = path.relative(ROOT, file);
  try {
    if (!script.id || ids.has(script.id)) throw new CompileError(-1, `Missing or duplicate id "${script.id}"`);
    if (!script.credits?.designer) throw new CompileError(-1, 'Every model needs credits.designer');
    ids.add(script.id);
    const m = compileModel(script, bases);
    fs.writeFileSync(out(`public/models/${m.id}.json`), JSON.stringify(m));
    fs.writeFileSync(out(`public/fold/${m.id}.fold`), JSON.stringify(toFold(m)));
    fs.copyFileSync(file, out(`public/src/${m.id}.yaml`));
    fs.writeFileSync(out(`public/thumbs/${m.id}.svg`), finalSvg(m, { width: 400, height: 400, padding: 0.12 }));
    compiled.push(m);
  } catch (e) {
    failed++;
    console.error(`✗ ${rel}: ${(e as Error).message}`);
  }
}
fs.writeFileSync(out('public/bases.json'), JSON.stringify(bases));
const index = buildIndex(compiled);
fs.writeFileSync(out('src/generated/index.json'), JSON.stringify(index));
fs.writeFileSync(out('public/search.json'), JSON.stringify(index));
console.log(`Compiled ${compiled.length} models, ${index.length - compiled.length} link-only entries${failed ? `, ${failed} failed` : ''}.`);
if (failed) process.exit(1);
