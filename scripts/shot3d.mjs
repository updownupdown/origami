// Dev helper: node scripts/shot3d.mjs <out-dir> <id>[:step[:t]] ...  (needs astro preview on :4321)
// Renders each model at a three-quarter angle after the paper settles.
import { chromium } from 'playwright';
const [dir, ...items] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
for (const it of items) {
  const [id, step, t] = it.split(':');
  await page.goto(`http://localhost:4321/origami/models/${id}/`);
  await page.waitForFunction(() => window.viewer, null, { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.evaluate(([s, t, EL]) => {
    const v = window.viewer;
    const n = s === undefined || s === '' ? v.stepCount : Number(s);
    v.showStep(n, { play: false, camera: false });
    if (t !== undefined) v.setT(Number(t));
    document.querySelectorAll('.stage > :not(.canvas)').forEach((e) => (e.style.display = 'none'));
    v.opts.cardOffset = false; v.resize();
    v.bestAngle(false);
    const c = v.camera, tg = v.controls.target;
    const r = c.position.clone().sub(tg).length() * 0.85, el = EL, az = -0.5;
    c.position.set(tg.x + r * Math.cos(el) * Math.sin(az), tg.y + r * Math.sin(el), tg.z + r * Math.cos(el) * Math.cos(az));
    c.lookAt(tg);
    v.controls.update();
  }, [step, t, Number(process.env.EL ?? 0.62)]);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${dir}/${id}${step !== undefined ? '-' + step : ''}${t !== undefined ? '-' + t : ''}.png` });
}
await b.close();
