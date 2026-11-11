import { describe, expect, it } from 'vitest';
import { apply, reflection, splitPolygon, det } from '../src/engine/geometry.ts';
import { compileModel, finalFaces } from '../src/engine/compile.ts';
import type { ModelScript } from '../src/engine/types.ts';
import { loadBases, loadModels } from '../scripts/lib.ts';

const sheet = (extra: Partial<ModelScript> = {}): ModelScript => ({
  id: 't', title: 'T', categories: [], difficulty: 1, credits: { designer: 'Test' },
  materials: [{ id: 'p', size: 10, start: 'front-up' }], steps: [], ...extra,
});

describe('geometry', () => {
  it('reflects across a line', () => {
    const R = reflection([0, 0], [1, 1]);
    expect(apply(R, [1, 0]).map((v) => +v.toFixed(9))).toEqual([0, 1]);
  });
  it('splits a square in half', () => {
    const [l, r] = splitPolygon([[0, 0], [2, 0], [2, 2], [0, 2]], [1, -1], [1, 3]);
    expect(l?.length).toBe(4);
    expect(r?.length).toBe(4);
  });
});

describe('folding', () => {
  it('book fold moves half the sheet on top', () => {
    const m = compileModel(sheet({ steps: [{ fold: 'valley', line: ['mid(A, D)', 'mid(B, C)'], move: 'A' }] }));
    const faces = finalFaces(m);
    expect(faces).toHaveLength(2);
    const moved = faces.find((f) => det(f.b) < 0)!;
    const still = faces.find((f) => det(f.b) > 0)!;
    expect(moved.lb).toBeGreaterThan(still.lb);
  });

  it('mountain fold puts the flap underneath', () => {
    const m = compileModel(sheet({ steps: [{ fold: 'mountain', line: ['mid(A, D)', 'mid(B, C)'], move: 'A' }] }));
    const faces = finalFaces(m);
    const moved = faces.find((f) => det(f.b) < 0)!;
    const still = faces.find((f) => det(f.b) > 0)!;
    expect(moved.lb).toBeLessThan(still.lb);
  });

  it('only creases the layers it moves', () => {
    const m = compileModel(sheet({ steps: [
      { fold: 'valley', line: ['mid(A, D)', 'mid(B, C)'], move: 'A' },
      { fold: 'valley', line: [[8, 0], [0, 4]], move: 'D', layers: 'top' },
    ] }));
    // Top layer split in two, bottom layer untouched.
    expect(finalFaces(m)).toHaveLength(3);
  });

  it('crease leaves the paper flat', () => {
    const m = compileModel(sheet({ steps: [{ crease: 'valley', line: ['A', 'C'], move: 'B' }] }));
    expect(finalFaces(m).every((f) => det(f.b) > 0)).toBe(true);
    expect(finalFaces(m)).toHaveLength(2);
  });

  it('reports a helpful error for an unknown point', () => {
    expect(() => compileModel(sheet({ steps: [{ fold: 'valley', line: ['A', 'Z'], move: 'B' }] }))).toThrow(/Step 1: Unknown point "Z"/);
  });

  it('waterbomb base from a book fold and two reverse folds', () => {
    const m = compileModel(sheet({ steps: [{ use: 'base/waterbomb' }] }), loadBases());
    const faces = finalFaces(m);
    // Triangle outline: all vertices within the top half after folding.
    const ys = faces.flatMap((f) => { const pts = []; for (let i = 0; i < f.p.length; i += 2) pts.push(apply(f.b, [f.p[i], f.p[i + 1]])[1]); return pts; });
    expect(Math.min(...ys)).toBeGreaterThan(-1e-6);
  });

  it('collapse rejects creases that cannot fold flat', () => {
    expect(() => compileModel(sheet({ steps: [{ collapse: { valley: [['A', 'C']], mountain: [['B', 'D']] } }] }))).toThrow(/fold flat/);
  });
});

describe('library', () => {
  it('every model compiles', () => {
    const bases = loadBases();
    for (const { file, script } of loadModels()) {
      expect(() => compileModel(script, bases), file).not.toThrow();
    }
  }, 60_000);
});
