// Dev helper: node scripts/shot.mjs <path> <out.png> [width] [height] [js-to-run]
import { chromium } from 'playwright';
const [p, out, w = 1280, h = 800, js] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: Number(w), height: Number(h) } });
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://localhost:4321/origami/${p}`);
await page.waitForTimeout(1500);
if (js) { await page.evaluate(js); await page.waitForTimeout(1200); }
await page.screenshot({ path: out });
await b.close();
