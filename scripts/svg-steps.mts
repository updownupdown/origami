// Dev helper: writes one PNG strip of every step's flat diagram for a model.
// node --experimental-strip-types scripts/svg-steps.mts <id> <out.html>
import fs from 'node:fs';
import { stepSvg, finalSvg } from '../src/engine/svg.ts';
const [id, out] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(`public/models/${id}.json`, 'utf8'));
const cells = m.steps.map((s: any, i: number) => `<figure>${stepSvg(m, i, { width: 220, height: 220, padding: 0.08 })}<figcaption>${i + 1}. ${s.text}</figcaption></figure>`);
cells.push(`<figure>${finalSvg(m, { width: 220, height: 220, padding: 0.08 })}<figcaption>Finished</figcaption></figure>`);
fs.writeFileSync(out, `<html><body style="display:flex;flex-wrap:wrap;gap:8px;font:12px sans-serif;width:1200px">${cells.join('')}</body></html>`.replace(/<figure>/g, '<figure style="width:220px;margin:0">'));
