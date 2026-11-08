import { chromium } from 'playwright';
const [inp, out] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 600 } });
await p.goto('file://' + inp);
await p.screenshot({ path: out, fullPage: true });
await b.close();
