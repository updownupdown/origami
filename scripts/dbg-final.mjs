// Screenshot of each model page jumped to its finished state, untouched (what a visitor sees).
import { chromium } from 'playwright';
const [dir, ...ids] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 600, height: 600 } });
for (const id of ids) {
  await page.goto(`http://localhost:4321/origami/models/${id}/?step=99`);
  await page.waitForFunction(() => window.viewer);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${dir}/${id}-page.png` });
}
await b.close();
