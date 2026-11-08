import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 600, height: 500 } });
const [id, st] = process.argv.slice(2);
await page.goto(`http://localhost:4321/origami/models/${id}/?step=${st}`);
await page.waitForFunction(() => window.viewer);
await page.waitForTimeout(3500);
console.log(await page.evaluate(() => {
  const v = window.viewer, s = v.sheets[0], P = s.pos;
  let mn = [1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[i+k]); mx[k] = Math.max(mx[k], P[i+k]); }
  const ph = v.phases[0];
  return JSON.stringify({ step: v.step, t: v.t, mn, mx, depthA: Array.from(ph.depthA), la: ph.faces.map(f => f.la), gap: v.layerGap, cam: v.camera.position.toArray(), near: v.camera.near });
}));
await b.close();
