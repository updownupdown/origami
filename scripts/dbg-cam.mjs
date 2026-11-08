import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 900, height: 700 } });
await page.goto(`http://localhost:4321/origami/models/${process.argv[2]}/?step=${process.argv[3]}`);
await page.waitForFunction(() => window.viewer);
await page.waitForTimeout(3000);
console.log(await page.evaluate(() => {
  const v = window.viewer; const P = v.sheets[0].pos;
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[i + k]); mx[k] = Math.max(mx[k], P[i + k]); }
  const f = (a) => a.map((x) => x.toFixed(1)).join(',');
  return `lift ${v.lift.toFixed(2)} min ${f(mn)} max ${f(mx)} cam ${f(v.camera.position.toArray())} target ${f(v.controls.target.toArray())} model3d ${f(v.model3d.position.toArray())}`;
}));
await b.close();
