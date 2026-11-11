// 3D shaping: turns the `shape` phases of a model into target fold angles for the simulation.
//
// The flat-fold engine only knows flat states (every crease open or folded flat). A shape phase
// leaves the flat state as it is and asks for some creases to sit at an in-between angle instead,
// such as the walls of a box at 90° or a body opened a little so the model stands. The angle
// holds for the rest of the model until a later fold changes that crease again.

import type { CompiledModel, Phase, PhaseShape } from './types.ts';
import type { SimMesh } from './sim.ts';

type V2 = [number, number];

export interface ShapeAngles {
  kind: 'flat' | 'crease';
  a: Float64Array[];
  b: Float64Array[];
  mid?: Float64Array[];
  match: Int32Array[];
  /** Hinges held at an exact 3D angle (no resting open or pressing flat), before and after the phase. */
  exA?: Uint8Array[];
  exB?: Uint8Array[];
}

const det = (m: number[]) => m[0] * m[3] - m[1] * m[2];
const ap = (m: number[], x: number, y: number): V2 => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function onSeg(p: V2, a: V2, b: V2): boolean {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
  if (t < -1e-4 || t > 1 + 1e-4) return false;
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) < 1e-4 * Math.sqrt(L2) + 1e-6;
}

/** Hinges that lie on a world segment in this phase's (static) flat state. */
function hingesOnLine(mesh: SimMesh, ph: Phase, match: Int32Array, p: V2, q: V2): number[] {
  const out: number[] = [];
  for (let h = 0; h < mesh.hingeCrease.length; h++) {
    if (!mesh.hingeCrease[h]) continue;
    const F = ph.faces[match[mesh.hingeFaces[2 * h]]];
    if (!F) continue;
    const ia = mesh.hinges[4 * h], ib = mesh.hinges[4 * h + 1];
    const pa = ap(F.a, mesh.paper[2 * ia], mesh.paper[2 * ia + 1]);
    const pb = ap(F.a, mesh.paper[2 * ib], mesh.paper[2 * ib + 1]);
    if (onSeg(pa, p, q) && onSeg(pb, p, q)) out.push(h);
  }
  return out;
}

/** Hinges that lie on a segment of the sheet's unfolded paper. */
function hingesOnPaper(mesh: SimMesh, p: V2, q: V2): number[] {
  const out: number[] = [];
  for (let h = 0; h < mesh.hingeCrease.length; h++) {
    if (!mesh.hingeCrease[h]) continue;
    const ia = mesh.hinges[4 * h], ib = mesh.hinges[4 * h + 1];
    if (onSeg([mesh.paper[2 * ia], mesh.paper[2 * ia + 1]], p, q) && onSeg([mesh.paper[2 * ib], mesh.paper[2 * ib + 1]], p, q)) out.push(h);
  }
  return out;
}

/**
 * Rewrites `angles` in place so shape phases bend the paper and later phases keep the bend.
 * `angles[step][phase]` must already hold the flat targets.
 */
export function applyShapes(model: CompiledModel, meshes: SimMesh[], angles: ShapeAngles[][]) {
  const has = model.steps.some((s) => s.phases.some((p) => p.motion === 'shape'));
  if (!has) return;
  // Hinges each named fold touched, with the direction it gave them (filled in as we go).
  const named = new Map<string, Float64Array[]>();
  const record = (ph: Phase, A: ShapeAngles) => {
    if (!ph.name) return;
    const dirs = named.get(ph.name) ?? meshes.map((m) => new Float64Array(m.hingeLen.length));
    meshes.forEach((_, i) => {
      const a = A.a[i], b = A.b[i], mid = A.mid?.[i];
      for (let h = 0; h < a.length; h++) {
        const v = b[h] !== a[h] ? b[h] || a[h] : mid?.[h] ?? 0;
        if (v) dirs[i][h] = Math.sign(v);
      }
    });
    named.set(ph.name, dirs);
  };

  // The way each crease was last folded: a crease that lies open folds that way again unless told otherwise.
  const last = meshes.map((m) => new Float64Array(m.hingeLen.length));
  const remember = (A: ShapeAngles) => meshes.forEach((_, i) => {
    const b = A.b[i], mid = A.mid?.[i];
    for (let h = 0; h < b.length; h++) { const v = b[h] || mid?.[h] || 0; if (v) last[i][h] = Math.sign(v); }
  });
  const cur = meshes.map((m) => new Float64Array(m.hingeLen.length).fill(NaN));
  const flags = () => cur.map((c) => Uint8Array.from(c, (v) => (Number.isNaN(v) ? 0 : 1)));
  model.steps.forEach((s, si) => s.phases.forEach((ph, pi) => {
    const A = angles[si][pi];
    if (ph.motion === 'shape' && ph.shape) {
      meshes.forEach((m, i) => {
        const a = A.a[i];
        for (let h = 0; h < a.length; h++) if (!Number.isNaN(cur[i][h])) a[h] = cur[i][h];
      });
      A.exA = flags();
      for (const sh of ph.shape) setShape(sh, ph, A, meshes, named, cur, last);
      A.b = meshes.map((_, i) => Float64Array.from(A.a[i], (v, h) => (Number.isNaN(cur[i][h]) ? v : cur[i][h])));
      A.exB = flags();
      record(ph, A);
      remember(A);
      return;
    }
    record(ph, A);
    remember(A);
    meshes.forEach((_, i) => {
      const a = A.a[i], b = A.b[i], mid = A.mid?.[i];
      for (let h = 0; h < a.length; h++) {
        if (Number.isNaN(cur[i][h])) continue;
        if (a[h] === b[h] && !(mid && mid[h])) { a[h] = b[h] = cur[i][h]; } else cur[i][h] = NaN;
      }
    });
    A.exA = A.exB = flags();
  }));
}

function setShape(sh: PhaseShape, ph: Phase, A: ShapeAngles, meshes: SimMesh[], named: Map<string, Float64Array[]>, cur: Float64Array[], last: Float64Array[]) {
  const rad = (sh.angle * Math.PI) / 180;
  meshes.forEach((mesh, i) => {
    let hs: number[];
    let dirOf: (h: number) => number;
    if (sh.name) {
      const d = named.get(sh.name);
      if (!d) return;
      hs = [];
      for (let h = 0; h < d[i].length; h++) if (d[i][h]) hs.push(h);
      dirOf = (h) => d[i][h];
    } else {
      hs = sh.paper ? (mesh.sheet === sh.paper ? hingesOnPaper(mesh, sh.p!, sh.q!) : []) : hingesOnLine(mesh, ph, A.match[i], sh.p!, sh.q!);
      dirOf = (h) => last[i][h];
    }
    for (const h of hs) {
      const now = A.a[i][h];
      let sign = now ? Math.sign(now) : dirOf(h);
      if (sh.kind) {
        // Valley seen from above: the wings rise towards the viewer.
        const F = ph.faces[A.match[i][mesh.hingeFaces[2 * h]]];
        const frontUp = F ? det(F.a) > 0 : true;
        const towardFront = sh.kind === 'valley' ? frontUp : !frontUp;
        if (!now) sign = towardFront ? -1 : 1;
      }
      if (!sign) continue;
      cur[i][h] = sign * rad;
    }
  });
}
