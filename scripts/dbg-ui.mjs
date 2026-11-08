import { chromium } from 'playwright';
const S = process.argv[2];
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 1100, height: 760 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
await page.goto('http://localhost:4321/origami/models/fox-face/?step=3');
await page.waitForFunction(() => window.viewer);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${S}/ui-main.png` });
// drag the bar
const box = await page.locator('#track').boundingBox();
await page.mouse.move(box.x + 5, box.y + box.height / 2);
await page.mouse.down();
for (let k = 0; k <= 10; k++) { await page.mouse.move(box.x + box.width * k * 0.06, box.y + box.height / 2); await page.waitForTimeout(80); }
console.log('during', await page.evaluate(() => [viewer.step, viewer.t.toFixed(2), document.getElementById('step-label').textContent]));
await page.mouse.up();
await page.waitForTimeout(1500);
console.log('after', await page.evaluate(() => [viewer.step, viewer.t.toFixed(2), viewer.playing]));
await page.click('#btn-paper');
await page.waitForTimeout(300);
await page.click('[data-pick=back]');
await page.screenshot({ path: `${S}/ui-paper.png` });
await page.keyboard.press('Escape');
await page.click('#btn-info');
await page.waitForTimeout(300);
await page.screenshot({ path: `${S}/ui-info.png` });
await b.close();
