// Renders a thumbnail of every finished model with the real 3D viewer.
// Run after `astro build`: node scripts/render-thumbs.mjs [id ...]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const dist = path.resolve('dist');
const base = '/origami/';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!p.startsWith(base)) { res.writeHead(404); return res.end(); }
  p = path.join(dist, p.slice(base.length));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const index = JSON.parse(fs.readFileSync(path.join(dist, 'search.json'), 'utf8'));
const only = process.argv.slice(2);
const ids = index.filter((e) => e.kind === 'foldable' && (!only.length || only.includes(e.id))).map((e) => e.id);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 480, height: 480 }, deviceScaleFactor: 1 });
fs.mkdirSync(path.join(dist, 'thumbs'), { recursive: true });
let ok = 0;
for (const id of ids) {
  try {
    await page.goto(`http://localhost:${port}${base}models/${id}/?thumb=1`);
    await page.waitForFunction(() => window.__thumbReady === true, null, { timeout: 20000 });
    await page.waitForTimeout(100);
    await page.locator('#canvas canvas').screenshot({ path: path.join(dist, 'thumbs', `${id}.png`), omitBackground: true });
    ok++;
  } catch (e) {
    console.error(`✗ ${id}: ${e.message}`);
  }
}
await browser.close();
server.close();
console.log(`Rendered ${ok}/${ids.length} thumbnails.`);
if (ok < ids.length) process.exitCode = 1;
