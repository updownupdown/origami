import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 600, height: 500 } });
const [id, st, fx, fy] = process.argv.slice(2);
await page.goto(`http://localhost:4321/origami/models/${id}/?step=${st}`);
await page.waitForFunction(() => window.viewer);
await page.waitForTimeout(3500);
console.log(await page.evaluate(([fx, fy]) => {
  const v = window.viewer, s = v.sheets[0], P = s.pos, T = s.mesh.tris, mesh = s.mesh;
  const lift = v.model3d.position.y;
  const ph = v.phases[0];
  const fm = v.faceMatch[0][0];
  // sample point: flat world (fx, fy) -> three (fx, ?, -fy)
  const X = Number(fx), Z = -Number(fy);
  const rows = [];
  for (let k = 0; k < T.length; k += 3) {
    const a = 3 * T[k], b = 3 * T[k + 1], c = 3 * T[k + 2];
    // barycentric in xz
    const x1 = P[a], z1 = P[a + 2], x2 = P[b], z2 = P[b + 2], x3 = P[c], z3 = P[c + 2];
    const d = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
    const l1 = ((z2 - z3) * (X - x3) + (x3 - x2) * (Z - z3)) / d, l2 = ((z3 - z1) * (X - x3) + (x1 - x3) * (Z - z3)) / d, l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    const y = l1 * P[a + 1] + l2 * P[b + 1] + l3 * P[c + 1] + lift;
    const f = ph.faces[fm[mesh.triFace[k / 3]]];
    const m = v.t >= 1 ? f.b : f.a;
    const ny = (P[b + 2] - P[a + 2]) * (P[c] - P[a]) - (P[b] - P[a]) * (P[c + 2] - P[a + 2]);
    rows.push({ y: y.toFixed(3), layer: v.t >= 1 ? f.lb : f.la, det: Math.sign(m[0] * m[3] - m[1] * m[2]), up: Math.sign(ny) });
  }
  rows.sort((p, q) => p.y - q.y);
  return rows.map((r) => `y=${r.y} layer=${r.layer} det=${r.det} up=${r.up}`).join('\n');
}, [fx, fy]));
await b.close();
