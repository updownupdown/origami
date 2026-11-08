import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { compileModel } from '../src/engine/compile.ts';
import { FoldSim } from '../src/engine/sim.ts';
import type { ModelScript } from '../src/engine/types.ts';

const tray = parse(`
id: t
title: T
categories: [boxes]
difficulty: 1
credits: { designer: Test }
materials: [{ id: paper, size: 12 }]
steps:
  - pattern:
      fixed: paper(6 6)
      valley:
        - [paper(3 0), paper(3 12), 90]
        - [paper(9 0), paper(9 12), 90]
        - [paper(0 3), paper(12 3), 90]
        - [paper(0 9), paper(12 9), 90]
  - stand: [paper(0 0), paper(12 0)]
`) as ModelScript;

describe('3D shaping', () => {
  it('compiles pattern, shape and stand phases', () => {
    const m = compileModel(tray);
    expect(m.steps[0].phases.map((p) => p.motion)).toEqual(['none', 'shape']);
    expect(m.steps[0].phases[1].faces.filter((f) => f.k).length).toBe(1);
    const st = m.steps[1].phases[0];
    expect(st.motion).toBe('stand');
    expect(st.tilt?.a1).toBe(90);
  });

  it('holds shaped creases at their angle', () => {
    const m = compileModel(tray);
    const sim = new FoldSim(m);
    sim.stateAt(m.steps.length);
    const th = sim.solvers[0].measure();
    const mesh = sim.meshes[0];
    const creased = [...th].filter((_, h) => mesh.hingeCrease[h]).map((a) => Math.abs(a));
    // Edge creases near 90°; the corner ones may differ a little where the walls meet.
    const near90 = creased.filter((a) => Math.abs(a - Math.PI / 2) < 0.2).length;
    expect(near90).toBeGreaterThan(creased.length / 2);
  });
});
