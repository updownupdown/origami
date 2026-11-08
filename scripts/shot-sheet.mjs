// Dev helper: node scripts/shot-sheet.mjs <out.png> <id>[:step] [more...]
// Renders each model (finished, or at the end of a step) from four angles into one contact sheet.
// Needs `astro dev` or `astro preview` on PORT (default 4321).
import { chromium } from 'playwright';
const [out, ...items] = process.argv.slice(2);
const port = process.env.PORT ?? 4321;
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 400, height: 400 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
const views = [[-30, 30], [60, 20], [180, 35], [0, 85]];
const shots = [];
for (const it of items) {
  const [id, step] = it.split(':');
  await page.goto(`http://localhost:${port}/origami/models/${id}/`);
  await page.waitForFunction(() => window.viewer, null, { timeout: 30000 });
  await page.evaluate((s) => {
    const v = window.viewer;
    const n = s === undefined || s === '' ? v.stepCount : Number(s);
    document.querySelectorAll('.stage > :not(.canvas)').forEach((e) => (e.style.display = 'none'));
    v.opts.cardOffset = false; v.resize();
    v.showStep(n, { play: false, camera: false });
    if (n < v.stepCount) v.setT(1);
  }, step);
  await page.waitForTimeout(2500);
  for (const [az, el] of views) {
    await page.evaluate(([az, el]) => {
      const v = window.viewer;
      v.bestAngle(false);
      const c = v.camera, tg = v.controls.target;
      const r = c.position.clone().sub(tg).length();
      const A = (az * Math.PI) / 180, E = (el * Math.PI) / 180;
      c.position.set(tg.x + r * Math.cos(E) * Math.sin(A), tg.y + r * Math.sin(E), tg.z + r * Math.cos(E) * Math.cos(A));
      c.lookAt(tg); v.controls.update();
    }, [az, el]);
    await page.waitForTimeout(400);
    shots.push(await page.screenshot());
  }
}
await b.close();
// Stitch: one row per model, four views across.
const p2 = await chromium.launch();
const pg = await p2.newPage({ viewport: { width: 1600, height: 400 * items.length } });
await pg.setContent(`<body style="margin:0;display:grid;grid-template-columns:repeat(4,400px)">${shots.map((s) => `<img src="data:image/png;base64,${s.toString('base64')}" width=400 height=400>`).join('')}${items.map((it, i) => `<div style="position:absolute;left:8px;top:${i * 400 + 6}px;font:14px sans-serif">${it}</div>`).join('')}</body>`);
await pg.screenshot({ path: out, fullPage: true });
await p2.close();
