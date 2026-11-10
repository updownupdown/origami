import { describe, expect, it } from 'vitest';
import { compileModel } from '../src/engine/compile.ts';
import { checkOrder } from '../src/engine/layers.ts';
import type { V2 } from '../src/engine/geometry.ts';
import { loadBases, loadModels } from '../scripts/lib.ts';

// After every flat fold, the layer order keeps paper from passing through paper.
const bases = loadBases();
const models = loadModels().filter((m) => m.script.kind !== 'base' && !m.file.includes('/drafts/'));

// Folds whose script asks for something paper can't do; the order there is the fold's own guess.
const KNOWN: Record<string, number[]> = {
  // "Fold the other wing behind": only the bottom layer is taken, so the corner flaps inside are left
  // crossing the fold.
  'paper-plane-dart': [8],
};

describe('layer order', () => {
  for (const { script } of models) {
    it(`${script.id}: every fold has a valid layer order`, () => {
      const m = compileModel(script, bases);
      const bad: string[] = [];
      m.steps.forEach((s, si) => {
        const ph = s.phases.at(-1);
        if (!ph || ph.motion !== 'hinge') return;
        for (const sheet of new Set(ph.faces.map((f) => f.s))) {
          const F = ph.faces.filter((f) => f.s === sheet);
          if (F.length < 3 || F.length > 400) continue;
          const faces = F.map((f) => {
            const poly: V2[] = [];
            for (let i = 0; i < f.p.length; i += 2) poly.push([f.p[i], f.p[i + 1]]);
            return { poly, T: f.b, layer: f.lb };
          });
          const r = checkOrder(faces, m.extent);
          if (!r) { if (!KNOWN[script.id]?.includes(si + 1)) bad.push(`step ${si + 1}: no order works`); }
          else if (r.changed) bad.push(`step ${si + 1}: ${r.changed} pairs out of order`);
        }
      });
      expect(bad).toEqual([]);
    });
  }
});
