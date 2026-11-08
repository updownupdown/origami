import { describe, expect, it } from 'vitest';
import { buildMesh, Solver } from '../src/engine/sim.ts';

const square = () => buildMesh('s', [[[0, 0], [1, 0], [1, 1]], [[0, 0], [1, 1], [0, 1]]], 1);

describe('sim', () => {
  it('builds one crease hinge for two triangles', () => {
    const m = square();
    expect(m.hingeCrease.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('dihedral gradient matches finite differences', () => {
    const m = square();
    const s = new Solver(m);
    // Random-ish 3D pose
    s.x.set([0, 0, 0.05, 1, 0.1, -0.1, 1.05, 0.95, 0.2, -0.05, 1, 0.3]);
    const h = 0;
    const g = new Float64Array(12);
    (s as any).theta[h] = 0;
    const t0 = (s as any).angle(h, g);
    const H = m.hinges;
    const ids = [H[0], H[1], H[2], H[3]];
    const eps = 1e-6;
    for (let k = 0; k < 4; k++) for (let c = 0; c < 3; c++) {
      const i = 3 * ids[k] + c;
      const old = s.x[i];
      s.x[i] = old + eps;
      (s as any).theta[h] = t0;
      const t1 = (s as any).angle(h, null);
      s.x[i] = old;
      expect(g[3 * k + c]).toBeCloseTo((t1 - t0) / eps, 4);
    }
  });

  it('a negative target folds towards the front (valley)', () => {
    const m = square();
    const s = new Solver(m);
    s.target[0] = -Math.PI * 0.5;
    for (let i = 0; i < 40; i++) s.step(200);
    expect(s.measure()[0]).toBeCloseTo(-Math.PI * 0.5, 1);
    // The two wing vertices both rise towards +z relative to the crease, or one does while the edge stays.
    const H = m.hinges;
    const zc = s.x[3 * H[2] + 2], zd = s.x[3 * H[3] + 2], ze = (s.x[3 * H[0] + 2] + s.x[3 * H[1] + 2]) / 2;
    expect(zc + zd - 2 * ze).toBeGreaterThan(0);
  });
});

import { alignRigid } from '../src/engine/sim.ts';
describe('alignRigid', () => {
  it('recovers a rotation and translation', () => {
    const src = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0.3];
    const a = 0.7, c = Math.cos(a), s = Math.sin(a);
    // rotate about (1,1,0)/√2-ish: use z then x
    const rot = (p: number[]) => { const x = c * p[0] - s * p[1], y = s * p[0] + c * p[1]; return [x, c * y - s * p[2] + 2, s * y + c * p[2] - 1]; };
    const dst: number[] = [];
    for (let i = 0; i < 5; i++) dst.push(...rot(src.slice(3 * i, 3 * i + 3)));
    const { R, t } = alignRigid(src, dst, [1, 1, 1, 1, 1]);
    for (let i = 0; i < 5; i++) {
      const p = src.slice(3 * i, 3 * i + 3);
      const q = [0, 1, 2].map((r) => R[3 * r] * p[0] + R[3 * r + 1] * p[1] + R[3 * r + 2] * p[2] + t[r]);
      q.forEach((v, k) => expect(v).toBeCloseTo(dst[3 * i + k], 6));
    }
  });
});
