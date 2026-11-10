// Paper thickness: which layer each face sits on.
//
// One rule for every pose, flat or 3D. Faces that touch (they lie in one plane and overlap) are
// stacked, and each gets a level: one more than the highest face it rests on. The order of two
// touching faces is the order in which they came to touch:
//
// - if they touch the way they lay in the flat diagram (same relative position), the diagram's
//   layer order says which is on top;
// - otherwise, the side one approached the other from while they were still apart.
//
// A level is returned as a signed number along the face's own front normal, so a stack keeps its
// order as it turns, and the viewer can blend levels between the rest poses at the ends of a phase.
//
// Pure TypeScript with no three.js, so it runs in the browser, in workers and in tests.

import type { SimMesh } from './sim.ts';

const faceVerts = new WeakMap<SimMesh, number[][]>();
/** The mesh vertices of each crease-pattern face. */
export function vertsOf(mesh: SimMesh): number[][] {
  let V = faceVerts.get(mesh);
  if (!V) {
    const sets = mesh.faces.map(() => new Set<number>());
    for (let k = 0; k < mesh.tris.length / 3; k++) for (let c = 0; c < 3; c++) sets[mesh.triFace[k]].add(mesh.tris[3 * k + c]);
    V = sets.map((x) => [...x]);
    faceVerts.set(mesh, V);
  }
  return V;
}

const hingedPairs = new WeakMap<SimMesh, Set<number>>();
function hingedOf(mesh: SimMesh): Set<number> {
  let H = hingedPairs.get(mesh);
  if (!H) {
    H = new Set<number>();
    for (let h = 0; h < mesh.hingeFaces.length / 2; h++) {
      const a = mesh.hingeFaces[2 * h], b = mesh.hingeFaces[2 * h + 1];
      if (a >= 0 && b >= 0 && a !== b) H.add(Math.min(a, b) * 65536 + Math.max(a, b));
    }
    hingedPairs.set(mesh, H);
  }
  return H;
}

/** What the flat diagram says about the faces at this pose (absent once there is no flat state). */
export interface FlatInfo {
  /** Flat transform per face (12 numbers: R row-major, then t), as in kinematic.ts. */
  F: Float64Array;
  /** Flat layer per face (higher is on top, seen from +z of the flat diagram); NaN for unknown. */
  layer: Float64Array;
}

interface Geo { C: Float64Array; N: Float64Array; box: Float64Array }

function geometry(mesh: SimMesh, P: ArrayLike<number>): Geo {
  const V = vertsOf(mesh), nf = V.length;
  const C = new Float64Array(3 * nf), N = new Float64Array(3 * nf), box = new Float64Array(6 * nf);
  for (let f = 0; f < nf; f++) {
    const vs = V[f];
    box[6 * f] = box[6 * f + 1] = box[6 * f + 2] = Infinity;
    box[6 * f + 3] = box[6 * f + 4] = box[6 * f + 5] = -Infinity;
    for (const v of vs) {
      for (let c = 0; c < 3; c++) {
        const x = P[3 * v + c];
        box[6 * f + c] = Math.min(box[6 * f + c], x); box[6 * f + 3 + c] = Math.max(box[6 * f + 3 + c], x);
        C[3 * f + c] += x / vs.length;
      }
    }
  }
  const T = mesh.tris;
  for (let k = 0; k < T.length / 3; k++) {
    const f = mesh.triFace[k], a = T[3 * k], b = T[3 * k + 1], c = T[3 * k + 2];
    const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
    const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
    N[3 * f] += uy * vz - uz * vy; N[3 * f + 1] += uz * vx - ux * vz; N[3 * f + 2] += ux * vy - uy * vx;
  }
  for (let f = 0; f < nf; f++) { const l = Math.hypot(N[3 * f], N[3 * f + 1], N[3 * f + 2]) || 1; N[3 * f] /= l; N[3 * f + 1] /= l; N[3 * f + 2] /= l; }
  return { C, N, box };
}

/**
 * Calls back for every pair of faces (a < b) that are nearly parallel, close and overlap seen along
 * a's normal, with b's signed distance from a's plane.
 */
function nearPairs(mesh: SimMesh, P: ArrayLike<number>, g: Geo, cb: (a: number, b: number, d: number, dot: number) => void) {
  const V = vertsOf(mesh), nf = V.length, { C, N, box } = g;
  const near = mesh.size * 0.05, tolOver = mesh.size * 4e-3;
  const order = [...Array(nf).keys()].sort((a, b) => box[6 * a] - box[6 * b]);
  for (let i = 0; i < nf; i++) {
    const f = order[i];
    for (let j = i + 1; j < nf; j++) {
      const h = order[j];
      if (box[6 * h] > box[6 * f + 3] + near) break;
      if (box[6 * h + 1] > box[6 * f + 4] + near || box[6 * f + 1] > box[6 * h + 4] + near || box[6 * h + 2] > box[6 * f + 5] + near || box[6 * f + 2] > box[6 * h + 5] + near) continue;
      const [a, b] = f < h ? [f, h] : [h, f];
      const dot = N[3 * a] * N[3 * b] + N[3 * a + 1] * N[3 * b + 1] + N[3 * a + 2] * N[3 * b + 2];
      if (Math.abs(dot) < 0.7) continue;
      let d = 0;
      for (const v of V[b]) d += (P[3 * v] - C[3 * a]) * N[3 * a] + (P[3 * v + 1] - C[3 * a + 1]) * N[3 * a + 1] + (P[3 * v + 2] - C[3 * a + 2]) * N[3 * a + 2];
      d /= V[b].length;
      if (Math.abs(d) > near) continue;
      if (!overlapAlong(P, V[a], V[b], N, a, tolOver)) continue;
      cb(a, b, d, dot);
    }
  }
}

const touching = (mesh: SimMesh, d: number, dot: number) => Math.abs(d) <= mesh.size * 4e-3 && Math.abs(dot) >= 0.995;

/**
 * Remembers, for pairs of faces that are close and overlapping but not yet touching, which side of
 * a's front the face b is on. Call it on the frames of a motion, in order.
 */
export function recordSides(mesh: SimMesh, P: ArrayLike<number>, sides: Map<number, number>) {
  nearPairs(mesh, P, geometry(mesh, P), (a, b, d, dot) => {
    if (!touching(mesh, d, dot) && Math.abs(d) > mesh.size * 4e-3) sides.set(a * 65536 + b, Math.sign(d));
  });
}

/** Whether faces a and b sit relative to each other as they did in the flat diagram. */
function asInDiagram(X: ArrayLike<number>, F: ArrayLike<number>, a: number, b: number, tol: number): boolean {
  // Relative transform of b in a's frame, in 3D and in the diagram: Ra^T Rb and Ra^T (tb - ta).
  const rel = (M: ArrayLike<number>) => {
    const A = 12 * a, B = 12 * b, out = new Array(12).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[3 * i + j] += M[A + 3 * k + i] * M[B + 3 * k + j];
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) out[9 + i] += M[A + 3 * k + i] * (M[B + 9 + k] - M[A + 9 + k]);
    return out;
  };
  const r3 = rel(X), rf = rel(F);
  for (let k = 0; k < 9; k++) if (Math.abs(r3[k] - rf[k]) > 1e-3) return false;
  for (let k = 9; k < 12; k++) if (Math.abs(r3[k] - rf[k]) > tol) return false;
  return true;
}

/**
 * Level of every face (signed, along its own front normal, in layers) for a pose: positions P (3 per
 * mesh vertex) and face transforms X. `flat` gives the diagram's layer order where there is one;
 * `sides` the remembered approach sides (see recordSides).
 */
export function stackLevels(mesh: SimMesh, P: ArrayLike<number>, X: ArrayLike<number>, flat: FlatInfo | null, sides: Map<number, number>): Float32Array {
  const nf = mesh.faces.length;
  const out = new Float32Array(nf);
  const g = geometry(mesh, P), N = g.N;
  const hinged = hingedOf(mesh);
  // Touching pairs, with b on side `sd` of a's front: [a, b, sd, priority].
  const touch: [number, number, number, number][] = [];
  nearPairs(mesh, P, g, (a, b, d, dot) => {
    if (!touching(mesh, d, dot)) return;
    let sd = 0, pri = 0;
    const key = a * 65536 + b;
    const la = flat ? flat.layer[a] : NaN, lb = flat ? flat.layer[b] : NaN;
    const known = flat && Number.isFinite(la) && Number.isFinite(lb) && la !== lb;
    if (known && asInDiagram(X, flat!.F, a, b, mesh.size * 4e-3)) {
      // Diagram order: b is on the side of a that was "up" in the diagram if b's layer is higher.
      // Up in the diagram (+z) for face a, carried into 3D: Ra · Fa^T · z.
      const A = 12 * a, F = flat!.F;
      const fz = [F[A + 6], F[A + 7], F[A + 8]]; // Fa^T z = third row of Fa
      const up = [0, 1, 2].map((i) => X[A + 3 * i] * fz[0] + X[A + 3 * i + 1] * fz[1] + X[A + 3 * i + 2] * fz[2]);
      const s = up[0] * N[3 * a] + up[1] * N[3 * a + 1] + up[2] * N[3 * a + 2];
      sd = Math.sign(s) * (lb > la ? 1 : -1);
      pri = 2;
    } else if (sides.get(key)) {
      sd = sides.get(key)!;
      pri = 1;
    } else if (known) {
      // Never seen apart and not as in the diagram: fall back on the diagram's order.
      const A = 12 * a, F = flat!.F;
      const fz = [F[A + 6], F[A + 7], F[A + 8]];
      const up = [0, 1, 2].map((i) => X[A + 3 * i] * fz[0] + X[A + 3 * i + 1] * fz[1] + X[A + 3 * i + 2] * fz[2]);
      sd = Math.sign(up[0] * N[3 * a] + up[1] * N[3 * a + 1] + up[2] * N[3 * a + 2]) * (lb > la ? 1 : -1);
    }
    if (!sd) return;
    if (hinged.has(key)) pri += 4;
    touch.push([a, b, sd, pri]);
  });
  if (!touch.length) return out;
  // Group touching faces; each group is stacked along its first face's normal.
  const par = [...Array(nf).keys()];
  const find = (x: number): number => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (const [a, b] of touch) par[find(a)] = find(b);
  const ref = new Int32Array(nf).fill(-1);
  for (const [a] of touch) { const r = find(a); if (ref[r] < 0) ref[r] = a; }
  // Strongest evidence first; an order that would contradict one already taken is dropped.
  touch.sort((x, y) => y[3] - x[3]);
  const above: number[][] = Array.from({ length: nf }, () => []);
  const below: number[][] = Array.from({ length: nf }, () => []);
  const reaches = (from: number, to: number) => {
    const seen = new Set([from]), st = [from];
    while (st.length) { const x = st.pop()!; if (x === to) return true; for (const y of above[x]) if (!seen.has(y)) { seen.add(y); st.push(y); } }
    return false;
  };
  // Each group stacks upwards along its normal turned to face up (+z), or for an upright group a fixed
  // way round, so the same pose always stacks the same way whichever face the group started from.
  const U = new Float64Array(3 * nf);
  for (let f = 0; f < nf; f++) {
    if (ref[f] < 0) continue;
    const r = ref[f];
    let x = N[3 * r], y = N[3 * r + 1], z = N[3 * r + 2];
    const flip = Math.abs(z) > 1e-3 ? z < 0 : Math.abs(y) > 1e-3 ? y < 0 : x < 0;
    if (flip) { x = -x; y = -y; z = -z; }
    U[3 * f] = x; U[3 * f + 1] = y; U[3 * f + 2] = z;
  }
  const upOf = (f: number) => { const r = find(f); return [U[3 * r], U[3 * r + 1], U[3 * r + 2]]; };
  for (const [a, b, sd] of touch) {
    const u = upOf(a);
    const up = sd * (N[3 * a] * u[0] + N[3 * a + 1] * u[1] + N[3 * a + 2] * u[2]) > 0;
    const [lo, hi] = up ? [a, b] : [b, a];
    if (!reaches(hi, lo)) { above[lo].push(hi); below[hi].push(lo); }
  }
  // Level = longest path up from the bottom of the group.
  const level = new Float64Array(nf).fill(-1);
  const depth = (f: number): number => {
    if (level[f] >= 0) return level[f];
    level[f] = 0;
    let d = 0;
    for (const g2 of below[f]) d = Math.max(d, depth(g2) + 1);
    return (level[f] = d);
  };
  for (let f = 0; f < nf; f++) {
    if (ref[find(f)] < 0) continue;
    const lv = depth(f), u = upOf(f);
    out[f] = lv * Math.sign(u[0] * N[3 * f] + u[1] * N[3 * f + 1] + u[2] * N[3 * f + 2] || 1);
  }
  return out;
}

/** Do two convex faces overlap (by more than tol) when seen along face a's normal? */
export function overlapAlong(P: ArrayLike<number>, A: number[], B: number[], N: Float64Array, a: number, tol: number): boolean {
  const nx = N[3 * a], ny = N[3 * a + 1], nz = N[3 * a + 2];
  let ux = -ny, uy = nx, uz = 0;
  if (Math.abs(nz) > 0.9) { ux = 0; uy = -nz; uz = ny; }
  const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  const proj = (vs: number[]) => {
    const pts = vs.map((v) => [P[3 * v] * ux + P[3 * v + 1] * uy + P[3 * v + 2] * uz, P[3 * v] * vx + P[3 * v + 1] * vy + P[3 * v + 2] * vz]);
    return hull(pts);
  };
  const pa = proj(A), pb = proj(B);
  for (const poly of [pa, pb]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      let ax = -(q[1] - p[1]), ay = q[0] - p[0];
      const l = Math.hypot(ax, ay);
      if (l < 1e-12) continue;
      ax /= l; ay /= l;
      let mina = Infinity, maxa = -Infinity, minb = Infinity, maxb = -Infinity;
      for (const r of pa) { const x = r[0] * ax + r[1] * ay; mina = Math.min(mina, x); maxa = Math.max(maxa, x); }
      for (const r of pb) { const x = r[0] * ax + r[1] * ay; minb = Math.min(minb, x); maxb = Math.max(maxb, x); }
      if (Math.min(maxa, maxb) - Math.max(mina, minb) < tol) return false;
    }
  }
  return true;
}

/** Convex hull (counter-clockwise) of 2D points; faces can carry points inside them from the triangulation. */
function hull(pts: number[][]): number[][] {
  const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return P;
  const cr = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: number[][] = [], up: number[][] = [];
  for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
