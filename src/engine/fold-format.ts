// Export a compiled model to the FOLD format (https://github.com/edemaine/fold).
// Frame 0 is the crease pattern of the finished model; one folded-state frame
// follows per step. Layer order is kept in the custom "origami:faces_layer" field.

import { apply, det, type Mat, type V2 } from './geometry.ts';
import type { CompiledModel, PhaseFace } from './types.ts';
import { stateBefore } from './svg.ts';

const unflat = (p: number[]): V2[] => {
  const out: V2[] = [];
  for (let i = 0; i < p.length; i += 2) out.push([p[i], p[i + 1]]);
  return out;
};

function topology(faces: PhaseFace[]) {
  const vKey = new Map<string, number>();
  const vertices: V2[] = [];
  const vid = (s: string, p: V2) => {
    const k = `${s}:${p[0].toFixed(5)},${p[1].toFixed(5)}`;
    let i = vKey.get(k);
    if (i === undefined) { i = vertices.length; vertices.push(p); vKey.set(k, i); }
    return i;
  };
  const faces_vertices = faces.map((f) => unflat(f.p).map((p) => vid(f.s, p)));
  const edgeMap = new Map<string, { v: [number, number]; faces: number[] }>();
  faces_vertices.forEach((fv, fi) => fv.forEach((v, i) => {
    const w = fv[(i + 1) % fv.length];
    const k = v < w ? `${v}-${w}` : `${w}-${v}`;
    const e = edgeMap.get(k) ?? { v: [Math.min(v, w), Math.max(v, w)] as [number, number], faces: [] };
    e.faces.push(fi);
    edgeMap.set(k, e);
  }));
  return { vertices, faces_vertices, edges: [...edgeMap.values()] };
}

export function toFold(model: CompiledModel): object {
  const final = stateBefore(model, model.steps.length);
  const topo = topology(final);
  const assign = topo.edges.map((e) => {
    if (e.faces.length < 2) return 'B';
    const [f, g] = e.faces.map((i) => final[i]);
    const same = f.b.every((v, i) => Math.abs(v - g.b[i]) < 1e-4);
    if (same) return 'F';
    return (det(f.b) > 0) === (g.lb > f.lb) ? 'V' : 'M';
  });
  const frames = model.steps.map((_, i) => {
    const st = stateBefore(model, i + 1);
    const t = topology(st);
    const coords: number[][] = t.vertices.map(() => [0, 0]);
    st.forEach((f, fi) => unflat(f.p).forEach((p, k) => {
      const w = apply(f.b as Mat, p);
      coords[t.faces_vertices[fi][k]] = [w[0], w[1]];
    }));
    return {
      frame_title: `Step ${i + 1}: ${model.steps[i].text}`,
      frame_classes: ['foldedForm'],
      frame_attributes: ['2D'],
      frame_inherit: false,
      vertices_coords: coords,
      faces_vertices: t.faces_vertices,
      'origami:faces_layer': st.map((f) => f.lb),
    };
  });
  return {
    file_spec: 1.1,
    file_creator: 'Origami (updownupdown.github.io/origami)',
    file_author: model.credits.designer,
    file_title: model.title,
    file_classes: ['singleModel'],
    frame_title: 'Crease pattern',
    frame_classes: ['creasePattern'],
    frame_attributes: ['2D'],
    vertices_coords: topo.vertices,
    faces_vertices: topo.faces_vertices,
    edges_vertices: topo.edges.map((e) => e.v),
    edges_assignment: assign,
    file_frames: frames,
  };
}
