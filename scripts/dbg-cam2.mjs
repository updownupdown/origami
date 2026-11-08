import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 600, height: 600 } });
await page.goto(`http://localhost:4321/origami/models/${process.argv[2]}/?step=99`);
await page.waitForFunction(() => window.viewer);
await page.waitForTimeout(2500);
console.log(await page.evaluate(() => {
  const v = window.viewer;
  const box = v.phases[0].bounds();
  return JSON.stringify({ step: v.step, cam: v.camera.position.toArray().map(x=>+x.toFixed(2)), tgt: v.controls.target.toArray().map(x=>+x.toFixed(2)), box: [box.min.toArray(), box.max.toArray()], lift: v.model3d.position.y, fin: v.model.finish.camera, near: v.camera.near, fov: v.camera.fov, aspect: v.camera.aspect });
}));
await b.close();
