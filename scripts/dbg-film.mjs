// Filmstrip of one step: node scripts/dbg-film.mjs <out.png> <id> <step 1-based> [frames]
import { chromium } from 'playwright';
import fs from 'node:fs';
const [out, id, st, nf = '12'] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 420, height: 420 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://localhost:4321/origami/models/${id}/?step=${st}`);
await page.waitForFunction(() => window.viewer);
await page.waitForTimeout(1500);
await page.evaluate(() => { document.querySelectorAll('.stage > :not(.canvas)').forEach((e) => (e.style.display = 'none')); viewer.opts.cardOffset = false; viewer.resize(); viewer.stop?.(); });
const shots = [];
const n = Number(nf);
for (let k = 0; k <= n; k++) {
  await page.evaluate((t) => { viewer.setT(t); }, k / n);
  await page.waitForTimeout(250);
  shots.push(await page.screenshot());
}
await b.close();
const html = `<html><body style="margin:0;display:flex;flex-wrap:wrap;width:${5 * 210}px">${shots.map((s, k) => `<div style="position:relative"><img src="data:image/png;base64,${s.toString('base64')}" width="210"><span style="position:absolute;left:4px;top:2px;font:12px sans-serif">${(k / n).toFixed(2)}</span></div>`).join('')}</body></html>`;
fs.writeFileSync(out + '.html', html);
const b2 = await chromium.launch();
const p2 = await b2.newPage({ viewport: { width: 1050, height: 400 } });
await p2.goto('file://' + out + '.html');
await p2.screenshot({ path: out, fullPage: true });
await b2.close();
