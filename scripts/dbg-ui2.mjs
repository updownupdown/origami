import { chromium } from 'playwright';
const S = process.argv[2];
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 1100, height: 760 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto('http://localhost:4321/origami/models/heart/?step=4');
await page.waitForFunction(() => window.viewer);
await page.waitForTimeout(3000);
await page.screenshot({ path: `${S}/m1.png` });
// tap the step knob = replay
await page.click('#sl-step .knob');
await page.waitForTimeout(300);
console.log('playing after tap', await page.evaluate(() => viewer.playing));
// drag all-steps
const box = await page.locator('#sl-all').boundingBox();
await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2); await page.mouse.down();
for (let k = 1; k <= 8; k++) { await page.mouse.move(box.x + box.width * (0.1 + k * 0.08), box.y + box.height / 2); await page.waitForTimeout(60); }
await page.mouse.up();
console.log('after drag', await page.evaluate(() => [viewer.step, document.querySelector('#sl-all .num').textContent]));
await page.waitForTimeout(800);
// flatness
await page.evaluate(() => { const f = document.getElementById('flatness'); f.value = '0'; f.dispatchEvent(new Event('input')); });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${S}/m2.png` });
await page.click('#btn-steps');
await page.waitForTimeout(500);
await page.screenshot({ path: `${S}/m3.png` });
await page.goto('http://localhost:4321/origami/');
await page.waitForTimeout(1200);
await page.click('#cat-btn');
await page.waitForTimeout(300);
await page.screenshot({ path: `${S}/m4.png` });
await b.close();
