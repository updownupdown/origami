import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 600, height: 500 } });
for (const [id, st] of [['heart', 6], ['heart', 8], ['heart', 9], ['fox-face', 6], ['cup', 99]]) {
  await page.goto(`http://localhost:4321/origami/models/${id}/`);
  await page.waitForFunction(() => window.viewer);
  await page.waitForTimeout(800);
  const r = await page.evaluate(async (st) => {
    const v = window.viewer;
    v.showStep(Math.min(st, v.stepCount), { play: false, camera: false });
    await new Promise((r) => setTimeout(r, 2500));
    const s = v.sheets[0], P = s.pos, T = s.mesh.tris, mesh = s.mesh;
    const idx = Math.min(v.phases.length - 1, Math.floor(v.t * v.phases.length - 1e-9));
    const match = v.vertMatch[0][Math.max(0, idx)];
    const ph = v.phases[Math.max(0, idx)];
    let agree = 0, tot = 0;
    for (let k = 0; k < T.length; k += 3) {
      const a = 3 * T[k], b = 3 * T[k + 1], c = 3 * T[k + 2];
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nyy = uz * vx - ux * vz;
      const fi = match[T[k]]; if (fi < 0) continue;
      const f = ph.faces[fi]; const m = v.t >= 1 ? f.b : f.a;
      const d = m[0] * m[3] - m[1] * m[2];
      tot++; if (Math.sign(nyy) === Math.sign(d)) agree++;
    }
    const simUp = (agree / tot).toFixed(2), flatUp = tot;
    return { step: v.step, t: v.t, simUp, flatUp };
  }, st);
  console.log(id, JSON.stringify(r));
}
await b.close();
