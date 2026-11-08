import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 900, height: 700 } });
await page.goto(`http://localhost:4321/origami/models/${process.argv[2]}/?step=${process.argv[3]}`);
await page.waitForFunction(() => window.viewer);
await page.waitForTimeout(3000);
console.log(await page.evaluate(() => {
  const v = window.viewer;
  const sv = v.sim.solvers[0], m = sv.mesh;
  const match = v.vertMatch[0][0];
  const out = [];
  for (let i = 0; i < Math.min(m.n, 12); i++) {
    const fi = match[i];
    const p = [m.paper[2*i], m.paper[2*i+1]];
    const pose = fi >= 0 ? v.phases[0].pose(fi, 0, p, new v.camera.position.constructor()).toArray().map((x) => x.toFixed(1)).join(',') : '-';
    out.push(`v${i} paper ${p.map((x)=>x.toFixed(1))} sim ${[0,1,2].map((k)=>(sv.x[3*i+k]*m.size).toFixed(1))} face ${fi} flat ${pose} w ${v.weights[0][i]}`);
  }
  return `phases ${v.phases.length} motion ${v.phases[0].phase.motion} t ${v.t}\n` + out.join('\n');
}));
await b.close();
