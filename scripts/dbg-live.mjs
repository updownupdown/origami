// Real-time playback filmstrip: node scripts/dbg-live.mjs <out.png> <base-url> <id> <step 1-based> [flatness 0..1]
import { chromium } from 'playwright';
import fs from 'node:fs';
const [out, base, id, st, flat] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 500, height: 700 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`${base}/models/${id}/?step=${st}`);
await page.waitForFunction(() => window.viewer);
if (flat) await page.evaluate((f) => viewer.setFlatness?.(Number(f)), flat);
const shots = [];
for (let k = 0; k < 15; k++) { shots.push(await page.screenshot()); await page.waitForTimeout(200); }
await b.close();
const html = `<html><body style="margin:0;display:flex;flex-wrap:wrap;width:${5 * 250}px">${shots.map((s, k) => `<div style="position:relative"><img src="data:image/png;base64,${s.toString('base64')}" width="250"><span style="position:absolute;left:4px;top:2px;font:12px sans-serif;background:#fff">${k * 0.2}s</span></div>`).join('')}</body></html>`;
fs.writeFileSync(out + '.html', html);
const b2 = await chromium.launch();
const p2 = await b2.newPage({ viewport: { width: 1250, height: 400 } });
await p2.goto('file://' + out + '.html');
await p2.screenshot({ path: out, fullPage: true });
await b2.close();
