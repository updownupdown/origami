// Scrubs a model's all-steps slider and checks the paper moves continuously and repeatably.
import { chromium } from 'playwright';
const id = process.argv[2] ?? 'heart';
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://localhost:4321/origami/models/${id}/?step=1`);
await page.waitForFunction(() => window.viewer);
await page.waitForTimeout(1500);
const res = await page.evaluate(async () => {
  const v = window.viewer, N = v.stepCount;
  const sample = (x) => {
    const i = Math.min(N, Math.floor(x)), t = i >= N ? 1 : x - i;
    if (v.step !== i) v.showStep(i, { play: false, camera: false });
    v.setT(t);
    v.updateMesh(0);
    const P = v.sheets[0].pos, y = v.model3d.position.y;
    return Array.from(P, (p, k) => (k % 3 === 1 ? p + y : p));
  };
  const xs = []; for (let x = 0; x <= N; x += 0.02) xs.push(x);
  const t0 = performance.now();
  const fwd = xs.map(sample);
  const ms = (performance.now() - t0) / xs.length;
  const back = xs.slice().reverse().map(sample).reverse();
  let maxJump = 0, at = 0, maxDiff = 0;
  for (let k = 1; k < fwd.length; k++) {
    let d = 0;
    for (let j = 0; j < fwd[k].length; j++) d = Math.max(d, Math.abs(fwd[k][j] - fwd[k - 1][j]));
    if (d > maxJump) { maxJump = d; at = xs[k]; }
  }
  let maxAcc = 0, accAt = 0;
  for (let k = 1; k < fwd.length - 1; k++) {
    let d = 0;
    for (let j = 0; j < fwd[k].length; j++) d = Math.max(d, Math.abs(fwd[k + 1][j] - 2 * fwd[k][j] + fwd[k - 1][j]));
    if (d > maxAcc) { maxAcc = d; accAt = xs[k]; }
  }
  for (let k = 0; k < fwd.length; k++) for (let j = 0; j < fwd[k].length; j++) maxDiff = Math.max(maxDiff, Math.abs(fwd[k][j] - back[k][j]));
  return { N, maxAcc: maxAcc.toFixed(3), accAt: accAt.toFixed(2), maxJump: maxJump.toFixed(3), at: at.toFixed(2), fwdVsBack: maxDiff.toFixed(4), msPerSample: ms.toFixed(1), extent: v.model.extent };
});
console.log(id, JSON.stringify(res));
await b.close();
