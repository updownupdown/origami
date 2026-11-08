// Usage: node --experimental-strip-types scripts/debug-render.mjs models/x.yaml out.png
import fs from 'node:fs';
import { parse } from 'yaml';
import { chromium } from 'playwright';
import { compileModel } from '../src/engine/compile.ts';
import { stepSvg, finalSvg } from '../src/engine/svg.ts';
import { loadBases } from './lib.ts';

const files = process.argv.slice(2);
const outDir = '/tmp/claude-0/-home-claude-origami/609f4bec-3fae-5e32-b38c-0af15a768f03/scratchpad/r';
const b = await chromium.launch();
for (const file of files) {
const out = `${outDir}/${file.split('/').pop().replace('.yaml', '.png')}`;
try {
const model = compileModel(parse(fs.readFileSync(file, 'utf8')), loadBases());
const cells = model.steps.map((_, i) => `<figure><div>${stepSvg(model, i, { width: 220, height: 220, background: '#f4efe6' })}</div><figcaption>${i + 1}. ${model.steps[i].text}</figcaption></figure>`);
cells.push(`<figure><div>${finalSvg(model, { width: 220, height: 220, background: '#f4efe6' })}</div><figcaption>Finished</figcaption></figure>`);
const html = `<html><body style="margin:0;font:12px sans-serif;display:grid;grid-template-columns:repeat(5,230px);gap:6px;padding:6px;width:1180px">${cells.map((c) => c.replace('<figure>', '<figure style="margin:0">')).join('')}</body></html>`;
const p = await b.newPage({ viewport: { width: 1190, height: 400 } });
await p.setContent(html);
await p.screenshot({ path: out, fullPage: true });
await p.close();
console.log('ok', out);
} catch (e) { console.log('ERR', file, e.message); }
}
await b.close();
