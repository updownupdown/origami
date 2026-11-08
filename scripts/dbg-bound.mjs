import { chromium } from 'playwright';
const [id, x0] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 900, height: 700 } });
await page.goto(`http://localhost:4321/origami/models/${id}/?step=1`);
await page.waitForFunction(() => window.viewer);
await page.waitForTimeout(1500);
console.log(await page.evaluate((X) => {
  const v = window.viewer, N = v.stepCount, out = [];
  let prev = null;
  for (const x of [X - 0.04, X - 0.01, X - 0.0001, X, X + 0.01, X + 0.04]) {
    const i = Math.min(N, Math.floor(x)), t = i >= N ? 1 : x - i;
    if (v.step !== i) v.showStep(i, { play: false, camera: false });
    v.setT(t); v.updateMesh(0);
    const P = Array.from(v.sheets[0].pos), S = Array.from(v.sim.solvers[0].x);
    let d = 0, ds = 0;
    if (prev) { for (let j = 0; j < P.length; j++) { d = Math.max(d, Math.abs(P[j] - prev.P[j])); ds = Math.max(ds, Math.abs(S[j] - prev.S[j])); } }
    out.push(`x=${x.toFixed(4)} step=${i} t=${t.toFixed(3)} lift=${v.model3d.position.y.toFixed(3)} dRender=${d.toFixed(3)} dSim=${(ds * v.sim.meshes[0].size).toFixed(3)} phases=${v.phases.map(p=>p.phase.motion).join(',')}`);
    prev = { P, S };
  }
  return out.join('\n');
}, Number(x0)));
await b.close();
