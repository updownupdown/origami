// Rigid-origami kinematics: exact 3D poses of the paper from fold angles.
//
// Every crease-pattern face is a rigid flat piece of paper. Faces are placed by chaining rotations
// about the creases of a spanning tree, starting from one face that stays put. The fold angles of
// the tree creases are the unknowns; every other crease must close up (both its faces meet along
// it) and all creases should sit as close as possible to their target angles. A damped
// Gauss-Newton solve finds that pose, so faces never stretch, bend or tear, and the result depends
// only on the targets and the path (no springs, no time step, no rounding-driven symmetry breaking).
//
// Targets come from the flat-fold engine (0 or ±π) and from `shape` steps (any angle). A step's
// motion is followed by small steps along the target path, each warm-started from the last, so the
// paper stays on one branch of its motion from start to end.
//
// Pure TypeScript with no three.js, so it runs in the browser, in workers and in tests.

import type { CompiledModel, Phase, PhaseFace } from './types.ts';
import { alignRigid, Solver, type SimMesh } from './sim.ts';
import { recordSides, stackLevels, vertsOf, type FlatInfo } from './stack.ts';

type V2 = [number, number];

/** Rigid transform from paper (x, y, 0) to the world: R (3x3, row-major) and t. 12 numbers per face. */
export type Xf = Float64Array;

export interface PhaseAnglesLike {
  kind: 'flat' | 'crease';
  a: Float64Array[];
  b: Float64Array[];
  mid?: Float64Array[];
  match: Int32Array[];
}

const ID: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export const easeCos = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, t)));

// ---------------------------------------------------------------------------
// Small rigid-transform helpers (12 numbers: R row-major, then t)

function compose(A: ArrayLike<number>, B: ArrayLike<number>, out: Float64Array, o = 0) {
  const r = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j];
    r[9 + i] = A[3 * i] * B[9] + A[3 * i + 1] * B[10] + A[3 * i + 2] * B[11] + A[9 + i];
  }
  for (let k = 0; k < 12; k++) out[o + k] = r[k];
}

/** Rotation by angle `th` about the axis through point `a` with unit direction `u` (right-hand rule). */
function axisRot(a: ArrayLike<number>, u: ArrayLike<number>, th: number): number[] {
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  const [x, y, z] = [u[0], u[1], u[2]];
  const R = [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
  const ax = a[0], ay = a[1], az = a[2] ?? 0;
  return [...R,
    ax - (R[0] * ax + R[1] * ay + R[2] * az),
    ay - (R[3] * ax + R[4] * ay + R[5] * az),
    az - (R[6] * ax + R[7] * ay + R[8] * az)];
}

function applyXf(T: ArrayLike<number>, o: number, x: number, y: number, out: number[] | Float64Array, k = 0) {
  out[k] = T[o] * x + T[o + 1] * y + T[o + 9];
  out[k + 1] = T[o + 3] * x + T[o + 4] * y + T[o + 10];
  out[k + 2] = T[o + 6] * x + T[o + 7] * y + T[o + 11];
}

/** A flat-fold 2D affine map (paper -> world) as a 3D rigid transform; a flip turns the paper over. */
export function lift(m: ArrayLike<number>): number[] {
  const s = m[0] * m[3] - m[1] * m[2] > 0 ? 1 : -1;
  return [m[0], m[2], 0, m[1], m[3], 0, 0, 0, s, m[4], m[5], 0];
}

function detOf(T: ArrayLike<number>, o: number): number {
  return T[o] * (T[o + 4] * T[o + 8] - T[o + 5] * T[o + 7]) - T[o + 1] * (T[o + 3] * T[o + 8] - T[o + 5] * T[o + 6]) + T[o + 2] * (T[o + 3] * T[o + 7] - T[o + 4] * T[o + 6]);
}

function invert(T: ArrayLike<number>): number[] {
  // R^T, -R^T t
  const R = [T[0], T[3], T[6], T[1], T[4], T[7], T[2], T[5], T[8]];
  return [...R,
    -(R[0] * T[9] + R[1] * T[10] + R[2] * T[11]),
    -(R[3] * T[9] + R[4] * T[10] + R[5] * T[11]),
    -(R[6] * T[9] + R[7] * T[10] + R[8] * T[11])];
}

function quatOf(R: ArrayLike<number>): number[] {
  const tr = R[0] + R[4] + R[8];
  let w: number, x: number, y: number, z: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (R[7] - R[5]) / s; y = (R[2] - R[6]) / s; z = (R[3] - R[1]) / s;
  } else if (R[0] > R[4] && R[0] > R[8]) {
    const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2;
    w = (R[7] - R[5]) / s; x = 0.25 * s; y = (R[1] + R[3]) / s; z = (R[2] + R[6]) / s;
  } else if (R[4] > R[8]) {
    const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2;
    w = (R[2] - R[6]) / s; x = (R[1] + R[3]) / s; y = 0.25 * s; z = (R[5] + R[7]) / s;
  } else {
    const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2;
    w = (R[3] - R[1]) / s; x = (R[2] + R[6]) / s; y = (R[5] + R[7]) / s; z = 0.25 * s;
  }
  return [w, x, y, z];
}

function quatToR(q: number[]): number[] {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** Interpolates between the identity and rigid transform D (rotation by slerp, translation linearly). */
function partial(D: number[], e: number): number[] {
  const q = quatOf(D);
  if (q[0] < 0) for (let k = 0; k < 4; k++) q[k] = -q[k];
  const ang = 2 * Math.acos(Math.min(1, q[0]));
  let r: number[];
  if (ang < 1e-9) r = [1, 0, 0, 0];
  else {
    const s = Math.sin(ang / 2), h = (ang * e) / 2;
    r = [Math.cos(h), (q[1] / s) * Math.sin(h), (q[2] / s) * Math.sin(h), (q[3] / s) * Math.sin(h)];
  }
  return [...quatToR(r), D[9] * e, D[10] * e, D[11] * e];
}

// ---------------------------------------------------------------------------
// Crease graph of one sheet

interface Edge {
  /** Face on the left of a→b (front side up) and on the right. */
  F: number;
  G: number;
  hinges: number[];
  a: V2;
  b: V2;
  /** Unit direction a→b in paper space. */
  u: V2;
}

interface SheetGraph {
  mesh: SimMesh;
  edges: Edge[];
  /** Edges at each face. */
  adj: number[][];
  area: Float64Array;
}

/** Rough distance between two 3D segments (6 numbers each): ends and middles against the other. */
function segDist3(A: Float64Array, B: Float64Array): number {
  const pt = (S: Float64Array, x: number, y: number, z: number) => {
    const dx = S[3] - S[0], dy = S[4] - S[1], dz = S[5] - S[2], L2 = dx * dx + dy * dy + dz * dz || 1e-18;
    const t = Math.max(0, Math.min(1, ((x - S[0]) * dx + (y - S[1]) * dy + (z - S[2]) * dz) / L2));
    return Math.hypot(S[0] + dx * t - x, S[1] + dy * t - y, S[2] + dz * t - z);
  };
  let d = Infinity;
  for (const [S, O] of [[A, B], [B, A]]) {
    for (const w of [0, 0.5, 1]) d = Math.min(d, pt(S, O[0] + (O[3] - O[0]) * w, O[1] + (O[4] - O[1]) * w, O[2] + (O[5] - O[2]) * w));
  }
  return d;
}

function polyArea(p: V2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; }
  return Math.abs(a) / 2;
}

function buildGraph(mesh: SimMesh): SheetGraph {
  const byPair = new Map<string, Edge>();
  const nh = mesh.hingeCrease.length;
  for (let h = 0; h < nh; h++) {
    if (!mesh.hingeCrease[h]) continue;
    const F = mesh.hingeFaces[2 * h], G = mesh.hingeFaces[2 * h + 1];
    const key = F < G ? `${F},${G}` : `${G},${F}`;
    const ia = mesh.hinges[4 * h], ib = mesh.hinges[4 * h + 1];
    const pa: V2 = [mesh.paper[2 * ia], mesh.paper[2 * ia + 1]], pb: V2 = [mesh.paper[2 * ib], mesh.paper[2 * ib + 1]];
    let e = byPair.get(key);
    if (!e) {
      const L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) || 1;
      e = { F, G, hinges: [], a: pa, b: pb, u: [(pb[0] - pa[0]) / L, (pb[1] - pa[1]) / L] };
      byPair.set(key, e);
    } else if (e.F === F) {
      // Extend to the longest span along the shared edge (same orientation).
      const t = (p: V2) => (p[0] - e!.a[0]) * e!.u[0] + (p[1] - e!.a[1]) * e!.u[1];
      const all = [e.a, e.b, pa, pb].sort((x, y) => t(x) - t(y));
      e.a = all[0]; e.b = all[3];
    }
    e.hinges.push(h);
  }
  const edges = [...byPair.values()];
  const adj: number[][] = mesh.faces.map(() => []);
  edges.forEach((e, k) => { adj[e.F].push(k); adj[e.G].push(k); });
  return { mesh, edges, adj, area: Float64Array.from(mesh.faces, polyArea) };
}

/** Signed fold angle of hinge edge e given the transforms of its faces (right face relative to left, about a→b). */
function measure(X: Float64Array, e: Edge, ref: number): number {
  const f = 12 * e.F, g = 12 * e.G;
  // Front normals R·z (third column) and the world axis R_F·u.
  const n1 = [X[f + 2], X[f + 5], X[f + 8]], n2 = [X[g + 2], X[g + 5], X[g + 8]];
  const ux = X[f] * e.u[0] + X[f + 1] * e.u[1], uy = X[f + 3] * e.u[0] + X[f + 4] * e.u[1], uz = X[f + 6] * e.u[0] + X[f + 7] * e.u[1];
  const cx = n1[1] * n2[2] - n1[2] * n2[1], cy = n1[2] * n2[0] - n1[0] * n2[2], cz = n1[0] * n2[1] - n1[1] * n2[0];
  let th = Math.atan2(cx * ux + cy * uy + cz * uz, n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]);
  let d = th - ref;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  th = ref + d;
  return th;
}

// ---------------------------------------------------------------------------
// Solving one pose

interface Tree {
  root: number;
  /** Faces in placement order (root first), with the edge to their parent and its direction. */
  order: number[];
  parent: Int32Array;
  pedge: Int32Array;
  /** +1 if the face is the right face (G) of its parent edge, -1 if the left (F). */
  side: Int8Array;
  /** Preorder index and subtree size, for "is face x below tree edge e". */
  pre: Int32Array;
  size: Int32Array;
  inTree: Uint8Array;
  /** Tree edges that are unknowns, and each edge's column (or -1). */
  vars: number[];
  col: Int32Array;
}

function buildTree(G: SheetGraph, root: number, rigid: Uint8Array): Tree {
  const nf = G.mesh.faces.length, ne = G.edges.length;
  const parent = new Int32Array(nf).fill(-1), pedge = new Int32Array(nf).fill(-1), side = new Int8Array(nf);
  const seen = new Uint8Array(nf), inTree = new Uint8Array(ne);
  // 0-1 breadth-first search: rigid (not yet made) creases cost nothing, so each rigid region is
  // placed as one flat piece and only made creases become unknowns.
  const order: number[] = [];
  const dq: number[] = [root];
  let head = 0;
  const dist = new Float64Array(nf).fill(Infinity);
  dist[root] = 0;
  const buf: number[] = [];
  while (head < dq.length || buf.length) {
    const x = head < dq.length ? dq[head++] : buf.shift()!;
    if (seen[x]) continue;
    seen[x] = 1;
    order.push(x);
    for (const k of G.adj[x]) {
      const e = G.edges[k], y = e.F === x ? e.G : e.F;
      if (seen[y]) continue;
      const d = dist[x] + (rigid[k] ? 0 : 1);
      if (d < dist[y]) {
        dist[y] = d; parent[y] = x; pedge[y] = k; side[y] = y === e.G ? 1 : -1;
        if (rigid[k]) dq.push(y); else buf.push(y);
      }
    }
  }
  for (const y of order) if (pedge[y] >= 0) inTree[pedge[y]] = 1;
  // Preorder for subtree tests.
  const kids: number[][] = Array.from({ length: nf }, () => []);
  for (const y of order) if (parent[y] >= 0) kids[parent[y]].push(y);
  const pre = new Int32Array(nf).fill(-1), size = new Int32Array(nf);
  let c = 0;
  const dfs = (x: number): number => {
    pre[x] = c++;
    let s = 1;
    for (const y of kids[x]) s += dfs(y);
    size[x] = s;
    return s;
  };
  dfs(root);
  const vars: number[] = [];
  const col = new Int32Array(ne).fill(-1);
  for (let k = 0; k < ne; k++) if (inTree[k] && !rigid[k]) { col[k] = vars.length; vars.push(k); }
  return { root, order, parent, pedge, side, pre, size, inTree, vars, col };
}

export interface SolveTargets {
  /** Target angle per edge. */
  rho: Float64Array;
  /** Weight per edge (0 for rigid edges, which are held at 0). */
  w: Float64Array;
  rigid: Uint8Array;
}

/** Places every face from the root transform and the tree angles. */
function place(G: SheetGraph, T: Tree, rootXf: ArrayLike<number>, theta: Float64Array, X: Float64Array) {
  for (let k = 0; k < 12; k++) X[12 * T.root + k] = rootXf[k];
  for (let i = 1; i < T.order.length; i++) {
    const y = T.order[i], x = T.parent[y], k = T.pedge[y], e = G.edges[k];
    const th = T.col[k] >= 0 ? theta[k] : 0;
    const M = axisRot([e.a[0], e.a[1], 0], [e.u[0], e.u[1], 0], T.side[y] * th);
    compose(X.subarray(12 * x, 12 * x + 12), M, X, 12 * y);
  }
}

const CLOSE_W = 1000;

/**
 * A point-pair constraint: S·T_F(p) must meet T_G(q). Crease closure uses S = identity and p = q on
 * the crease; symmetry uses a world isometry S and the mirror point q = σ(p) on the mirror face G.
 */
export interface PairConstraint { F: number; p: V2; G: number; q: V2; S: number[] | null; w: number; closure: boolean }

/**
 * Finds the pose nearest the targets. `theta` holds the starting tree angles (per edge) and is
 * updated. Returns the closure error (largest gap at a crease, as a fraction of the sheet size).
 */
function solvePose(G: SheetGraph, T: Tree, rootXf: ArrayLike<number>, tg: SolveTargets, theta: Float64Array, X: Float64Array, iters = 12, extra: PairConstraint[] = []): number {
  const ne = G.edges.length, n = T.vars.length, S = G.mesh.size;
  const pairs: PairConstraint[] = [];
  const angEdges: number[] = [];
  for (let k = 0; k < ne; k++) {
    const e = G.edges[k];
    if (!T.inTree[k]) for (const p of [e.a, e.b]) pairs.push({ F: e.F, p, G: e.G, q: p, S: null, w: CLOSE_W, closure: true });
    if (tg.w[k] > 0 && !tg.rigid[k]) angEdges.push(k);
  }
  pairs.push(...extra);
  const m = 3 * pairs.length + angEdges.length;
  const r = new Float64Array(m);
  const A = new Float64Array(n * n), g = new Float64Array(n);
  const P = new Float64Array(6), Q = new Float64Array(3);
  // World axis (unit, signed by the child's side) and a point on it, for each tree variable edge.
  const om = new Float64Array(3 * n), po = new Float64Array(3 * n);
  let lambda = 1e-7, gap = Infinity;
  const childOf = new Int32Array(ne).fill(-1);
  for (const y of T.order) if (T.pedge[y] >= 0) childOf[T.pedge[y]] = y;
  // The unknowns between each face and the root: only these move it, so each row of the Jacobian is
  // short (sparse), which keeps big tessellations fast.
  const path: Int32Array[] = [];
  for (const y of T.order) {
    const k = T.pedge[y];
    if (k < 0) { path[y] = new Int32Array(0); continue; }
    const up = path[T.parent[y]];
    if (T.col[k] < 0) { path[y] = up; continue; }
    const pa = new Int32Array(up.length + 1);
    pa.set(up); pa[up.length] = T.col[k];
    path[y] = pa;
  }
  // Per row: columns, and for point rows whether the F side and the G side move with that column.
  const rowCols: Int32Array[] = [], rowF: Uint8Array[] = [], rowG: Uint8Array[] = [];
  const mark = new Int32Array(n).fill(0);
  const rowsFor = (F: number, Gf: number, both: boolean) => {
    const pf = path[F] ?? new Int32Array(0), pg = path[Gf] ?? new Int32Array(0);
    for (const c of pf) mark[c] |= 1;
    for (const c of pg) mark[c] |= 2;
    const cols: number[] = [], f: number[] = [], gg: number[] = [];
    for (const c of pf) if (mark[c]) { if (mark[c] !== 3 || both) { cols.push(c); f.push(1); gg.push(mark[c] & 2 ? 1 : 0); } mark[c] = 0; }
    for (const c of pg) if (mark[c]) { if (mark[c] !== 3 || both) { cols.push(c); f.push(mark[c] & 1 ? 1 : 0); gg.push(1); } mark[c] = 0; }
    return { cols: Int32Array.from(cols), f: Uint8Array.from(f), g: Uint8Array.from(gg) };
  };
  for (const c of pairs) {
    const rw = rowsFor(c.F, c.G, !!c.S);
    rowCols.push(rw.cols); rowF.push(rw.f); rowG.push(rw.g);
  }
  for (const k of angEdges) {
    if (T.inTree[k]) {
      rowCols.push(T.col[k] >= 0 ? Int32Array.of(T.col[k]) : new Int32Array(0)); rowF.push(new Uint8Array(1)); rowG.push(new Uint8Array(1));
    } else {
      const e = G.edges[k], rw = rowsFor(e.F, e.G, false);
      rowCols.push(rw.cols); rowF.push(rw.f); rowG.push(rw.g);
    }
  }
  // Jacobian values: 3 per point row (x, y, z), 1 per angle row, aligned with rowCols.
  const jv: Float64Array[] = rowCols.map((c, i) => new Float64Array(c.length * (i < pairs.length ? 3 : 1)));
  const pairPoints = (c: PairConstraint) => {
    applyXf(X, 12 * c.F, c.p[0], c.p[1], P, 0);
    applyXf(X, 12 * c.G, c.q[0], c.q[1], P, 3);
    if (c.S) {
      const M = c.S, x = P[0], y = P[1], z = P[2];
      P[0] = M[0] * x + M[1] * y + M[2] * z + M[9];
      P[1] = M[3] * x + M[4] * y + M[5] * z + M[10];
      P[2] = M[6] * x + M[7] * y + M[8] * z + M[11];
    }
  };

  const residual = (): number => {
    let i = 0, mx = 0;
    for (const c of pairs) {
      pairPoints(c);
      for (let k = 0; k < 3; k++) {
        const d = (P[k] - P[3 + k]) / S;
        r[i++] = c.w * d;
        if (c.closure) mx = Math.max(mx, Math.abs(d));
      }
    }
    for (const k of angEdges) {
      const th = T.inTree[k] ? theta[k] : measure(X, G.edges[k], tg.rho[k]);
      r[i++] = tg.w[k] * (th - tg.rho[k]);
    }
    return mx;
  };
  const cost = () => { let s = 0; for (let i = 0; i < m; i++) s += r[i] * r[i]; return s; };

  place(G, T, rootXf, theta, X);
  gap = residual();
  let c0 = cost();
  if (n === 0) return gap;
  const th0 = new Float64Array(theta.length);
  for (let it = 0; it < iters; it++) {
    // Jacobian.
    T.vars.forEach((k, j) => {
      const y = childOf[k], x = T.parent[y], e = G.edges[k];
      const o = 12 * x;
      // world axis = R_parent · u, point = T_parent(a); the child turns by side·dθ about it.
      const s = T.side[y];
      om[3 * j] = s * (X[o] * e.u[0] + X[o + 1] * e.u[1]);
      om[3 * j + 1] = s * (X[o + 3] * e.u[0] + X[o + 4] * e.u[1]);
      om[3 * j + 2] = s * (X[o + 6] * e.u[0] + X[o + 7] * e.u[1]);
      applyXf(X, o, e.a[0], e.a[1], po, 3 * j);
    });
    pairs.forEach((c, pi) => {
      applyXf(X, 12 * c.F, c.p[0], c.p[1], P, 0);
      applyXf(X, 12 * c.G, c.q[0], c.q[1], P, 3);
      const M = c.S, k0 = c.w / S, cols = rowCols[pi], fF = rowF[pi], fG = rowG[pi], out = jv[pi];
      for (let q = 0; q < cols.length; q++) {
        const j = cols[q];
        const wx = om[3 * j], wy = om[3 * j + 1], wz = om[3 * j + 2];
        const qx = po[3 * j], qy = po[3 * j + 1], qz = po[3 * j + 2];
        let jx = 0, jy = 0, jz = 0;
        if (fF[q]) {
          const dx = P[0] - qx, dy = P[1] - qy, dz = P[2] - qz;
          let vx = wy * dz - wz * dy, vy = wz * dx - wx * dz, vz = wx * dy - wy * dx;
          if (M) { Q[0] = M[0] * vx + M[1] * vy + M[2] * vz; Q[1] = M[3] * vx + M[4] * vy + M[5] * vz; Q[2] = M[6] * vx + M[7] * vy + M[8] * vz; vx = Q[0]; vy = Q[1]; vz = Q[2]; }
          jx += vx; jy += vy; jz += vz;
        }
        if (fG[q]) {
          const dx = P[3] - qx, dy = P[4] - qy, dz = P[5] - qz;
          jx -= wy * dz - wz * dy; jy -= wz * dx - wx * dz; jz -= wx * dy - wy * dx;
        }
        out[3 * q] = k0 * jx; out[3 * q + 1] = k0 * jy; out[3 * q + 2] = k0 * jz;
      }
    });
    angEdges.forEach((k, ai) => {
      const ri = pairs.length + ai, cols = rowCols[ri], out = jv[ri];
      const e = G.edges[k];
      if (T.inTree[k]) { if (cols.length) out[0] = tg.w[k]; return; }
      const o = 12 * e.F;
      const ux = X[o] * e.u[0] + X[o + 1] * e.u[1], uy = X[o + 3] * e.u[0] + X[o + 4] * e.u[1], uz = X[o + 6] * e.u[0] + X[o + 7] * e.u[1];
      const fF = rowF[ri], fG = rowG[ri];
      for (let q = 0; q < cols.length; q++) {
        const j = cols[q];
        out[q] = tg.w[k] * (fG[q] - fF[q]) * (om[3 * j] * ux + om[3 * j + 1] * uy + om[3 * j + 2] * uz);
      }
    });
    // Normal equations (upper triangle), from the sparse rows.
    A.fill(0); g.fill(0);
    const addRow = (cols: Int32Array, vals: Float64Array, stride: number, off: number, rv: number) => {
      for (let a = 0; a < cols.length; a++) {
        const ja = vals[stride * a + off];
        if (ja === 0) continue;
        const ca = cols[a];
        g[ca] += ja * rv;
        for (let b = 0; b < cols.length; b++) {
          const cb = cols[b];
          if (cb < ca) continue;
          A[ca * n + cb] += ja * vals[stride * b + off];
        }
      }
    };
    for (let pi = 0; pi < pairs.length; pi++) for (let d = 0; d < 3; d++) addRow(rowCols[pi], jv[pi], 3, d, r[3 * pi + d]);
    for (let ai = 0; ai < angEdges.length; ai++) { const ri = pairs.length + ai; addRow(rowCols[ri], jv[ri], 1, 0, r[3 * pairs.length + ai]); }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a * n + b] = A[b * n + a];
    th0.set(theta);
    let improved = false;
    for (let tries = 0; tries < 6; tries++) {
      const Ad = A.slice();
      for (let a = 0; a < n; a++) Ad[a * n + a] += lambda * (1 + A[a * n + a]);
      const dx = cholSolve(Ad, g, n);
      if (!dx) { lambda *= 10; continue; }
      T.vars.forEach((k, j) => (theta[k] = th0[k] - dx[j]));
      place(G, T, rootXf, theta, X);
      const gp = residual();
      const c1 = cost();
      if (c1 <= c0) {
        const drop = c0 - c1;
        c0 = c1; gap = gp; lambda = Math.max(1e-12, lambda * 0.1); improved = true;
        let step = 0;
        for (let j = 0; j < n; j++) step = Math.max(step, Math.abs(dx[j]));
        // Converged: the angles barely move, or the error has stopped going down.
        if (step < 1e-7 || drop < 1e-12 * (1 + c1)) it = iters;
        break;
      }
      lambda *= 10;
    }
    if (!improved) {
      theta.set(th0);
      place(G, T, rootXf, theta, X);
      gap = residual();
      break;
    }
  }
  return gap;
}

function cholSolve(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const L = A; // in place
  for (let j = 0; j < n; j++) {
    let s = L[j * n + j];
    for (let k = 0; k < j; k++) s -= L[j * n + k] * L[j * n + k];
    if (s <= 1e-300) return null;
    const d = Math.sqrt(s);
    L[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let t = L[i * n + j];
      for (let k = 0; k < j; k++) t -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = t / d;
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let t = b[i];
    for (let k = 0; k < i; k++) t -= L[i * n + k] * y[k];
    y[i] = t / L[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let t = y[i];
    for (let k = i + 1; k < n; k++) t -= L[k * n + i] * y[k];
    y[i] = t / L[i * n + i];
  }
  return y;
}

// ---------------------------------------------------------------------------
// Symmetry: a fold the script asks for symmetrically is shown symmetrically.
//
// Near the flat state the paper can often move along several branches at once, and a solver that
// only minimises error picks one of them on the strength of rounding. When the crease pattern, the
// targets and the starting pose all share a symmetry of the sheet (a mirror or a turn), the solve is
// held to that symmetry, so a box's two ends rise together and a mirror-image model stays mirrored.

interface Sym { fmap: Int32Array; sigma: number[]; S: number[] }

function mapP(m: number[], p: V2): V2 { return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]; }

function findSymmetries(G: SheetGraph, X0: Float64Array, root: number, sig: (k: number) => string, moving: (k: number) => boolean): Sym[] {
  const mesh = G.mesh, nf = mesh.faces.length, tol = mesh.size * 1e-4;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < mesh.n; i++) {
    x0 = Math.min(x0, mesh.paper[2 * i]); x1 = Math.max(x1, mesh.paper[2 * i]);
    y0 = Math.min(y0, mesh.paper[2 * i + 1]); y1 = Math.max(y1, mesh.paper[2 * i + 1]);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, square = Math.abs((x1 - x0) - (y1 - y0)) < tol;
  // 2D maps [m0, m1, m2, m3, tx, ty] about the centre: mirrors first, then turns.
  const lin: number[][] = [[-1, 0, 0, 1], [1, 0, 0, -1]];
  if (square) lin.push([0, 1, 1, 0], [0, -1, -1, 0], [0, 1, -1, 0]);
  lin.push([-1, 0, 0, -1]);
  const cands = lin.map(([a, b, c, d]) => [a, b, c, d, cx - (a * cx + c * cy), cy - (b * cx + d * cy)]);
  const pairKey = new Map<string, number>();
  G.edges.forEach((e, k) => pairKey.set(e.F < e.G ? `${e.F},${e.G}` : `${e.G},${e.F}`, k));
  const out: Sym[] = [];
  for (const sigma of cands) {
    if (out.length >= 2) break;
    const fmap = new Int32Array(nf).fill(-1);
    let ok = true;
    for (let f = 0; f < nf && ok; f++) {
      const q = mapP(sigma, mesh.faceSample[f]);
      for (let g = 0; g < nf; g++) {
        const r = mesh.faceSample[g];
        if (Math.abs(r[0] - q[0]) < tol && Math.abs(r[1] - q[1]) < tol) { fmap[f] = g; break; }
      }
      if (fmap[f] < 0) ok = false;
    }
    if (!ok) continue;
    for (let k = 0; k < G.edges.length && ok; k++) {
      const e = G.edges[k], F = fmap[e.F], Gf = fmap[e.G];
      const k2 = pairKey.get(F < Gf ? `${F},${Gf}` : `${Gf},${F}`);
      if (k2 === undefined || sig(k) !== sig(k2)) ok = false;
    }
    if (!ok) continue;
    // The symmetry is held as a fixed map of the world, which is only right if the root's partner
    // stays where it is too: the root itself, or a face that no moving crease separates from it.
    // (A strip curled up from one end panel is mirror-symmetric, but about a plane that travels.)
    if (fmap[root] !== root) {
      const seen = new Uint8Array(nf), todo = [root];
      seen[root] = 1;
      while (todo.length) {
        const x = todo.pop()!;
        for (const k of G.adj[x]) {
          const e = G.edges[k], y = e.F === x ? e.G : e.F;
          if (!seen[y] && !moving(k)) { seen[y] = 1; todo.push(y); }
        }
      }
      if (!seen[fmap[root]]) continue;
    }
    // The world map that takes the starting pose onto itself.
    const s3 = [sigma[0], sigma[2], 0, sigma[1], sigma[3], 0, 0, 0, 1, sigma[4], sigma[5], 0];
    const tmp = new Float64Array(12), S = new Float64Array(12);
    compose(X0.subarray(12 * fmap[root], 12 * fmap[root] + 12), s3, tmp);
    compose(tmp, invert(X0.subarray(12 * root, 12 * root + 12)), S);
    const lhs = new Float64Array(12), rhs = new Float64Array(12);
    for (let f = 0; f < nf && ok; f++) {
      compose(X0.subarray(12 * fmap[f], 12 * fmap[f] + 12), s3, lhs);
      compose(S, X0.subarray(12 * f, 12 * f + 12), rhs);
      for (let k = 0; k < 12; k++) if (Math.abs(lhs[k] - rhs[k]) > (k < 9 ? 1e-4 : tol)) { ok = false; break; }
    }
    if (ok) out.push({ fmap, sigma, S: Array.from(S) });
  }
  return out;
}

function symmetryPairs(G: SheetGraph, syms: Sym[]): PairConstraint[] {
  const out: PairConstraint[] = [];
  for (const sy of syms) {
    G.mesh.faces.forEach((poly, f) => {
      const k = poly.length;
      for (const i of [0, Math.floor(k / 3), Math.floor((2 * k) / 3)]) {
        const p = poly[i];
        out.push({ F: f, p, G: sy.fmap[f], q: mapP(sy.sigma, p), S: sy.S, w: CLOSE_W, closure: false });
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Whole-model timeline

/** Rigid motion of a phase face over the phase (whole flaps turning, sheets moved or spun), as a 3D transform. */
export function faceMotion(ph: Phase, f: PhaseFace, t: number): number[] {
  const e = easeCos(t);
  const A = lift(f.a), B = lift(f.b);
  const D = (() => { const out = new Float64Array(12); compose(B, invert(A), out); return Array.from(out); })();
  if (ph.motion === 'spin' && ph.center) {
    const ang = (((ph.angle ?? 0) * Math.PI) / 180) * e;
    return axisRot([ph.center[0], ph.center[1], 0], [0, 0, 1], ang);
  }
  if ((ph.motion === 'hinge' || ph.motion === 'crease') && ph.axis && f.d !== 0) {
    const [P, Q] = ph.axis;
    const L = Math.hypot(Q[0] - P[0], Q[1] - P[1]) || 1;
    const u = [(Q[0] - P[0]) / L, (Q[1] - P[1]) / L, 0];
    if (ph.motion === 'crease') return axisRot([P[0], P[1], 0], u, Math.PI * 0.85 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t)) * f.d);
    if (ph.motion === 'hinge' && ph.spine) return reverseMotion(ph.spine, u, D, e);
    const M = axisRot([P[0], P[1], 0], u, Math.PI * e * f.d);
    const Mend = axisRot([P[0], P[1], 0], u, Math.PI * f.d);
    // Land exactly where the flat engine says (any shift beyond the pure turn is added in linearly).
    for (let k = 9; k < 12; k++) M[k] += (D[k] - Mend[k]) * e;
    return M;
  }
  return partial(D, e);
}

/**
 * A reverse fold. Paper has to flex to make one, so no rigid motion exists; this one keeps the flap
 * inside the model's plane, as it is in the hand: the flap swings about the point where the fold
 * line meets its spine, and at the same time narrows onto its spine and opens out again on the
 * other side (it turns inside out, seen flat). The start and end are the exact folded poses.
 */
function reverseMotion(spine: [V2, V2], u: number[], D: number[], e: number): number[] {
  const [V, far] = spine;
  const L = Math.hypot(far[0] - V[0], far[1] - V[1]) || 1;
  const s = [(far[0] - V[0]) / L, (far[1] - V[1]) / L];
  let th = 2 * (Math.atan2(u[1], u[0]) - Math.atan2(s[1], s[0]));
  while (th > Math.PI) th -= 2 * Math.PI;
  while (th <= -Math.PI) th += 2 * Math.PI;
  const c = Math.cos(Math.PI * e), k = 1 - c;
  // Narrowing across the spine (and through the thickness), about V.
  const S = [c + k * s[0] * s[0], k * s[0] * s[1], 0, k * s[0] * s[1], c + k * s[1] * s[1], 0, 0, 0, c];
  const St = [...S, V[0] - (S[0] * V[0] + S[1] * V[1]), V[1] - (S[3] * V[0] + S[4] * V[1]), 0];
  const M = new Float64Array(12);
  compose(axisRot([V[0], V[1], 0], [0, 0, 1], th * e), St, M);
  const end = new Float64Array(12);
  const Se = [2 * s[0] * s[0] - 1, 2 * s[0] * s[1], 0, 2 * s[0] * s[1], 2 * s[1] * s[1] - 1, 0, 0, 0, -1];
  compose(axisRot([V[0], V[1], 0], [0, 0, 1], th), [...Se, V[0] - (Se[0] * V[0] + Se[1] * V[1]), V[1] - (Se[3] * V[0] + Se[4] * V[1]), 0], end);
  const out = Array.from(M);
  // Land exactly where the flat engine says.
  for (let i = 0; i < 12; i++) out[i] += (D[i] - end[i]) * e;
  return out;
}

export interface KinFrame { t: number; X: Float64Array[] }

/**
 * A model's solved steps, worked out when the site is built so the browser only replays them.
 * Per step: how it is shown, and the level of every face at each rest pose. Steps that need the
 * solver (collapses, 3D shaping and everything after) also carry their frames: per frame, per sheet,
 * per face a rotation (quaternion) and a translation, as float32, base64.
 */
export interface KinRecord {
  v: 1;
  /** Crease-pattern faces per sheet, to check the record matches the meshes. */
  faces: number[];
  steps: {
    tier: StepTier;
    spans: [number, number][];
    missed: number;
    /** Levels: rests × sheets × faces, int16, base64. */
    levels: string;
    frames?: { t: number[]; X: string; flip: string };
    /** Bent paper: per frame, per sheet, per mesh vertex a position (cm), float32, base64. */
    soft?: string;
  }[];
}

const b64 = (bytes: Uint8Array) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => { const bin = atob(s), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

/**
 * How a step is shown: 'exact' (flat folds, drawn from the flat-fold engine), 'kinematic' (rigid
 * motion of linked creases), 'staggered' (flaps folded one after another so they do not collide),
 * or 'crossing' (no rigid motion keeps the paper apart; shown as a staged move instead).
 */
export type StepTier = 'exact' | 'kinematic' | 'staggered' | 'crossing';

/** Above this many unknowns the crossing check is skipped (big tessellations fold all at once). */
const CHECK_LIMIT = 200;
/** A collapse whose solved end misses its folded angles by more than this (radians) is staged instead. */
const MISS_LIMIT = 0.05;

export interface KinOptions {
  /** Samples per phase that changes fold angles. */
  samples?: number;
}

/**
 * Exact 3D poses of a model through its steps. Built from the same meshes and target angles as the
 * physics simulation, but solved as rigid origami.
 */
export class Kinematics {
  graphs: SheetGraph[];
  /** Face transforms at the start of each step (index = step; steps = finished). */
  private start: (Float64Array[] | undefined)[] = [];
  /** Recorded poses through each step (time 0..1 across the whole step). */
  frames: (KinFrame[] | undefined)[] = [];
  /**
   * Steps where the paper bends: positions of every mesh vertex per frame (same times as `frames`,
   * whose face transforms are then the best rigid fit of each face). Once paper has bent, every
   * later step carries on from the bent shape.
   */
  soft: (Float64Array[][] | undefined)[] = [];
  private softStart: (Float64Array[] | undefined)[] = [];
  /** Largest crease gap (fraction of the sheet) seen while solving each step. */
  gap: number[] = [];
  samples: number;
  /** How each step is shown (see StepTier), and in how many frames paper still crosses paper. */
  tier: StepTier[] = [];
  crossed: number[] = [];
  /** Per step: time spans to dissolve across instead of moving through (paper would cross paper). */
  spans: [number, number][][] = [];
  /** Largest gap (degrees) between a crease the step moves and the angle the script asks for, at its end. */
  missed: number[] = [];
  /**
   * Paper thickness (see stack.ts): per step, per rest pose (the start of each phase, then the end of
   * the step), per sheet, the level of each crease-pattern face along its own front normal.
   */
  levels: (Float32Array[][] | undefined)[] = [];
  /** Steps solved at build time (see KinRecord). */
  private rec: KinRecord['steps'] | null = null;
  /** Which side each pair of nearby faces approached from, at the start of each step (per sheet). */
  private sides: (Map<number, number>[] | undefined)[] = [];
  /** Symmetries held in the last phase set up, per sheet (for diagnostics). */
  symmetries: number[] = [];

  model: CompiledModel;
  meshes: SimMesh[];
  angles: PhaseAnglesLike[][];
  born: Int32Array[];

  constructor(model: CompiledModel, meshes: SimMesh[], angles: PhaseAnglesLike[][], born: Int32Array[], opt: KinOptions = {}) {
    this.model = model; this.meshes = meshes; this.angles = angles; this.born = born;
    this.graphs = meshes.map(buildGraph);
    this.samples = opt.samples ?? 24;
  }

  /** Face transforms at the start of step s (s = steps for the finished model). */
  stateAt(s: number): Float64Array[] {
    let k = s;
    // Steps before any 3D shaping start from the exact flat-fold pose; only shaped paper chains on.
    while (k > 0 && !this.start[k] && this.shapedBefore(k)) k--;
    if (!this.start[k]) this.start[k] = this.flatStart(k);
    for (; k < s; k++) this.runStep(k);
    return this.start[s]!;
  }

  /** True when a step before step s shapes the paper in 3D (so its pose is not the flat one). */
  shapedBefore(s: number): boolean {
    for (let k = 0; k < Math.min(s, this.model.steps.length); k++) if (this.model.steps[k].phases.some((p) => p.motion === 'shape' || p.motion === 'pose')) return true;
    return false;
  }

  /**
   * Starts the chain at step s from the exact flat-fold pose (the first phase's "before" faces, or the
   * last phase's "after" faces of an earlier step).
   */
  flatStart(s: number): Float64Array[] {
    let faces: PhaseFace[] | null = null, which: 'a' | 'b' = 'a', match: Int32Array[] | null = null;
    if (this.model.steps[s]?.phases.length) { faces = this.model.steps[s].phases[0].faces; match = this.angles[s][0].match; }
    else {
      for (let k = s - 1; k >= 0 && !faces; k--) {
        const ph = this.model.steps[k].phases;
        if (ph.length) { faces = ph[ph.length - 1].faces; which = 'b'; match = this.angles[k][ph.length - 1].match; }
      }
    }
    return this.graphs.map((G, si) => {
      const nf = G.mesh.faces.length, X = new Float64Array(12 * nf);
      for (let f = 0; f < nf; f++) {
        const fi = match ? match[si][f] : -1;
        const T = faces && fi >= 0 ? lift(which === 'a' ? faces[fi].a : faces[fi].b) : ID;
        for (let k = 0; k < 12; k++) X[12 * f + k] = T[k];
      }
      return X;
    });
  }

  ensureStep(s: number) {
    if (s >= this.model.steps.length || this.frames[s]) return;
    this.stateAt(s);
    this.runStep(s);
  }

  /** Solves step s from its start state to its end, recording frames. */
  runStep(s: number) {
    if (this.rec?.[s]?.frames) { this.adopt(s); return; }
    const step = this.model.steps[s];
    if (this.softStart[s] || step.phases.some((p) => p.soft)) { this.runSoft(s); return; }
    const np = Math.max(1, step.phases.length);
    let X: Float64Array[] = this.stateAt(s).map((x) => x.slice());
    const frames: KinFrame[] = [{ t: 0, X: X.map((x) => x.slice()) }];
    let worst = 0, tier: StepTier = 'exact', crossed = 0, missed = 0;
    const badTimes: number[] = [];
    let flat = !this.shapedBefore(s);
    let stagedEnd = false;
    step.phases.forEach((ph, p) => {
      const A = this.angles[s][p];
      const now = s * 64 + Math.min(p, 63);
      if (ph.pose) {
        // A folded sheet picked up and set down as one rigid piece: turned about the point it is held
        // by while that point travels over in a low arc.
        if (flat) X = this.flatPose(ph, A, 'a');
        flat = false;
        const { from, to, R } = ph.pose, si = this.meshes.findIndex((m) => m.sheet === ph.pose!.sheet);
        const X0 = X, hop = 0.3 * Math.hypot(to[0] - from[0], to[1] - from[1]), K = 16;
        for (let k = 1; k <= K; k++) {
          const e = easeCos(k / K), Re = partial([...R, 0, 0, 0], e), D = new Float64Array(12);
          D.set(Re.slice(0, 9));
          for (let i = 0; i < 3; i++) {
            D[9 + i] = from[i] + (to[i] - from[i]) * e - (Re[3 * i] * from[0] + Re[3 * i + 1] * from[1] + Re[3 * i + 2] * from[2]);
          }
          D[11] += hop * Math.sin(Math.PI * e);
          X = X0.map((x, i) => {
            if (i !== si) return x;
            const o = new Float64Array(x.length);
            for (let f = 0; f < x.length; f += 12) compose(D, x.subarray(f, f + 12), o, f);
            return o;
          });
          frames.push({ t: (p + k / K) / np, X: X.map((x) => x.slice()) });
        }
        return;
      }
      if (flat) {
        // Paper not shaped yet: start from the exact flat-fold pose of this phase.
        X = this.flatPose(ph, A, 'a');
        if (ph.motion !== 'chain' && ph.motion !== 'refold' && ph.motion !== 'shape') {
          // A plain fold: flaps turn rigidly about their hinge, exactly as the flat-fold engine says.
          const K = ph.motion === 'none' || ph.motion === 'stand' ? 1 : this.samples;
          for (let k = 1; k <= K; k++) {
            const t = k / K;
            frames.push({ t: (p + t) / np, X: this.flatPose(ph, A, t) });
          }
          X = this.flatPose(ph, A, 'b');
          return;
        }
      }
      if (ph.motion === 'shape') flat = false;
      const X0 = X;
      const run = (order: number[][] | null, firm = false) => {
        const sheets = this.graphs.map((G, si) => this.setupPhase(G, si, ph, A, now, X0[si], order?.[si], firm));
        const changes = sheets.some((sh) => sh.changes);
        const moves = sheets.some((sh) => sh.moves);
        // Big tessellations take fewer samples (each solve is costlier); frames are blended in between.
        const nv = Math.max(...sheets.map((sh) => sh.unknowns));
        const K = changes ? Math.max(8, Math.round(this.samples * Math.min(1, 90 / Math.max(1, nv)))) : moves ? 12 : 1;
        const out: KinFrame[] = [];
        let gap = 0, bad = 0, Xe = X0;
        const badT: number[] = [];
        const check = changes && nv <= CHECK_LIMIT;
        for (let k = 1; k <= K; k++) {
          const t = k / K;
          Xe = sheets.map((sh, si) => {
            const o = new Float64Array(12 * this.graphs[si].mesh.faces.length);
            gap = Math.max(gap, sh.solveAt(t, o));
            return o;
          });
          if (check && Xe.some((Xs, si) => crossings(this.meshes[si], this.positions(si, Xs), undefined, 1).length)) { bad++; badT.push((p + t) / np); }
          if (K > 1 || changes || moves) out.push({ t: (p + t) / np, X: Xe.map((x) => x.slice()) });
        }
        return { out, gap, bad, badT, Xe, changes, sheets, miss: Math.max(0, ...sheets.map((sh, si) => sh.miss(Xe[si]))) };
      };
      let best = run(null);
      if (best.changes && tier === 'exact') tier = 'kinematic';
      if (best.bad) {
        // Some paper passes through other paper. Fold the separate flaps one after another, as a
        // person would, in whichever order keeps them apart.
        const groups = best.sheets.map((sh) => sh.groups);
        if (groups.some((g) => g.length > 1)) {
          for (const rev of [false, true]) {
            const order = groups.map((g) => (rev ? g.slice().reverse() : g));
            const alt = run(order);
            if (alt.bad < best.bad) { best = alt; tier = 'staggered'; }
            if (!best.bad) break;
          }
        }
      }
      if (best.bad && ph.motion === 'shape') {
        // Shaping lets the creases it does not name give a little. If that lets layers slip through
        // each other, try again with the flat-folded layers held together; keep it if the shape is
        // still reached.
        const alt = run(null, true);
        if (alt.bad < best.bad && alt.miss <= best.miss + MISS_LIMIT) best = alt;
      }
      if (best.bad) { crossed += best.bad; badTimes.push(...best.badT); }
      worst = Math.max(worst, best.gap);
      if (flat && (ph.motion === 'chain' || ph.motion === 'refold') && best.miss > MISS_LIMIT && best.out.length) {
        // A collapse the rigid solver can't finish (a bird base needs its paper to flex). Keep the
        // solved motion for the start, then dissolve into the exact folded pose.
        const end = this.flatPose(ph, A, 'b');
        const cut = (p + 0.6) / np;
        const keep = best.out.filter((f) => f.t < cut);
        frames.push(...keep, { t: (p + 1) / np, X: end.map((x) => x.slice()) });
        badTimes.push((p + 1) / np);
        tier = 'crossing';
        stagedEnd = true;
        X = end;
        return;
      }
      missed = Math.max(missed, best.miss);
      frames.push(...best.out);
      X = best.Xe;
    });
    if (crossed) tier = 'crossing';
    if (frames[frames.length - 1].t < 1) frames.push({ t: 1, X: X.map((x) => x.slice()) });
    this.frames[s] = frames;
    // Spans where paper would pass through paper: from the last clean frame before to the first
    // clean frame after. The viewer dissolves from one to the other across these.
    const spans: [number, number][] = [];
    const ts = frames.map((f) => f.t);
    for (const bt of badTimes) {
      let j = ts.findIndex((t) => Math.abs(t - bt) < 1e-9);
      if (j < 0) continue;
      let a = j, b = j;
      while (a > 0 && badTimes.some((x) => Math.abs(x - ts[a]) < 1e-9)) a--;
      while (b < ts.length - 1 && badTimes.some((x) => Math.abs(x - ts[b]) < 1e-9)) b++;
      const last = spans[spans.length - 1];
      if (last && ts[a] <= last[1] + 1e-9) last[1] = Math.max(last[1], ts[b]);
      else spans.push([ts[a], ts[b]]);
    }
    this.spans[s] = spans;
    if (this.rec?.[s]) this.levels[s] = this.recLevels(s);
    else this.stackStep(s, frames);
    this.gap[s] = worst;
    this.tier[s] = tier;
    this.crossed[s] = crossed;
    this.missed[s] = (missed * 180) / Math.PI;
    // Until the paper has been shaped, every step starts again from the exact flat-fold pose.
    this.start[s + 1] = this.shapedBefore(s + 1) ? X : this.flatStart(s + 1);
  }

  /**
   * A step where the paper bends. The sheet is a mesh of stiff bars with springy hinges (sim.ts);
   * the step's creases are driven to their angles and the rest of the paper gives way as it must.
   */
  private runSoft(s: number) {
    const step = this.model.steps[s], np = Math.max(1, step.phases.length);
    const X0 = this.stateAt(s);
    let P = this.softStart[s] ?? X0.map((X, si) => this.positions(si, X));
    const solvers = this.meshes.map((mesh, si) => {
      const sv = new Solver(mesh, { facet: 0.08 });
      for (let i = 0; i < P[si].length; i++) sv.x[i] = P[si][i] / mesh.size;
      // Fold angles near ±180° are read relative to what the script says they are.
      const A = this.angles[s][0];
      if (A) sv.theta.set(A.a[si]);
      sv.measure().forEach((t, h) => (sv.theta[h] = t));
      sv.target.set(sv.theta);
      for (let h = 0; h < sv.target.length; h++) if (!mesh.hingeCrease[h]) sv.target[h] = 0;
      return sv;
    });
    // The part of the model that is held still (the step's "fixed" point) does not give way, and the
    // creases the step folds are worked firmly; the rest of the paper follows.
    const hold = (ph: Phase, A: PhaseAnglesLike) => solvers.forEach((sv, si) => {
      const mesh = this.meshes[si], V = vertsOf(mesh);
      const pin = new Uint8Array(mesh.n);
      let any = false;
      V.forEach((vs, f) => { const pf = ph.faces[A.match[si][f]]; if (pf?.k) { any = true; for (const v of vs) pin[v] = 1; } });
      if (!any) {
        // No fixed point given: the paper that stayed still when the named folds were made stays still now.
        const names = new Set((ph.shape ?? []).map((c) => c.name).filter(Boolean));
        this.model.steps.slice(0, s).forEach((st, s2) => st.phases.forEach((q, p2) => {
          if (!q.name || !names.has(q.name) || q.motion !== 'hinge') return;
          const M = this.angles[s2][p2].match[si];
          V.forEach((vs, f) => { const qf = q.faces[M[f]]; if (qf && qf.d === 0) { any = true; for (const v of vs) pin[v] = 1; } });
        }));
      }
      sv.pinned = any ? pin : null;
      for (let h = 0; h < sv.kHinge.length; h++) {
        if (!mesh.hingeCrease[h]) continue;
        sv.kHinge[h] = sv.kCrease[h] * (Math.abs(A.b[si][h] - sv.target[h]) > 1e-6 ? 6 : 0.15);
      }
    });
    const read = () => solvers.map((sv, si) => { const o = new Float64Array(sv.x.length), z = this.meshes[si].size; for (let i = 0; i < o.length; i++) o[i] = sv.x[i] * z; return o; });
    const ts = [0], Ps = [P.map((x) => x.slice())];
    step.phases.forEach((ph, p) => {
      const A = this.angles[s][p];
      // Only a phase that folds something works the paper; turning or standing the model leaves it as it is.
      const moves = A.a.some((a, si) => a.some((v, h) => this.meshes[si].hingeCrease[h] && Math.abs(A.b[si][h] - v) > 1e-6));
      if (!moves) return;
      solvers.forEach((sv, si) => { for (let h = 0; h < sv.target.length; h++) if (this.meshes[si].hingeCrease[h]) sv.target[h] = A.a[si][h]; });
      hold(ph, A);
      const from = solvers.map((sv) => sv.target.slice());
      const K = this.samples;
      for (let k = 1; k <= K; k++) {
        const e = easeCos(k / K);
        solvers.forEach((sv, si) => {
          const mesh = this.meshes[si];
          for (let h = 0; h < sv.target.length; h++) if (mesh.hingeCrease[h]) sv.target[h] = from[si][h] + (A.b[si][h] - from[si][h]) * e;
          sv.drag = 0.995;
          sv.step(k === K ? 4000 : 500);
        });
        ts.push((p + k / K) / np);
        Ps.push(read());
      }
    });
    if (ts[ts.length - 1] < 1) { ts.push(1); Ps.push(Ps[Ps.length - 1].map((x) => x.slice())); }
    this.soft[s] = Ps;
    // Each face's best rigid fit, for everything that thinks in whole faces (paper thickness).
    const fit = (Pf: Float64Array[]) => Pf.map((Q, si) => {
      const mesh = this.meshes[si], V = vertsOf(mesh), X = new Float64Array(12 * mesh.faces.length);
      V.forEach((vs, f) => {
        const src: number[] = [], dst: number[] = [];
        for (const v of vs) { src.push(mesh.paper[2 * v], mesh.paper[2 * v + 1], 0); dst.push(Q[3 * v], Q[3 * v + 1], Q[3 * v + 2]); }
        const { R, t } = alignRigid(src, dst, vs.map(() => 1));
        X.set([...R, ...t], 12 * f);
      });
      return X;
    });
    const frames = ts.map((t, i) => ({ t, X: fit(Ps[i]) }));
    this.frames[s] = frames;
    this.spans[s] = [];
    if (this.rec?.[s]) this.levels[s] = this.recLevels(s);
    else this.stackStep(s, frames);
    this.gap[s] = 0;
    this.tier[s] = 'kinematic';
    this.crossed[s] = 0;
    this.missed[s] = 0;
    this.start[s + 1] = frames[frames.length - 1].X;
    this.softStart[s + 1] = Ps[Ps.length - 1];
  }

  /**
   * Face transforms at time t through step s when every face of the paper is rigid there (so each
   * can be placed exactly, on its own), or null where the paper is bent: then only `posAt` knows it.
   */
  rigidAt(s: number, t: number): Float64Array[] | null {
    const n = this.model.steps.length;
    if (s >= n) { const X = this.stateAt(n); return this.softStart[n] ? null : X; }
    this.ensureStep(s);
    return this.soft[s] ? null : this.frameAt(s, t);
  }

  /** Positions (cm, 3 per mesh vertex) of every sheet at time t through step s. */
  posAt(s: number, t: number): Float64Array[] {
    const n = this.model.steps.length;
    if (s >= n) {
      const X = this.stateAt(n);
      return this.softStart[n] ?? X.map((Xs, si) => this.positions(si, Xs));
    }
    this.ensureStep(s);
    const S = this.soft[s];
    if (!S) return this.frameAt(s, t).map((Xs, si) => this.positions(si, Xs));
    const F = this.frames[s]!;
    let j = 0;
    while (j < F.length - 1 && F[j + 1].t <= t) j++;
    const k = Math.min(F.length - 1, j + 1);
    const w = F[k].t > F[j].t ? Math.max(0, Math.min(1, (t - F[j].t) / (F[k].t - F[j].t))) : 0;
    return S[j].map((a, si) => { const b = S[k][si], o = new Float64Array(a.length); for (let i = 0; i < o.length; i++) o[i] = a[i] + (b[i] - a[i]) * w; return o; });
  }

  private setupPhase(G: SheetGraph, si: number, ph: Phase, A: PhaseAnglesLike, now: number, X0: Float64Array, order?: number[], firm = false) {
    const mesh = G.mesh, ne = G.edges.length, nf = mesh.faces.length;
    const match = A.match[si];
    const born = this.born[si];
    // Root face: an anchor that stays still, else the biggest still face, else the biggest face.
    let root = -1, best = -1;
    const score = (f: number) => {
      const pf = ph.faces[match[f]];
      if (!pf) return -1;
      return (pf.k ? 4 : 0) + (pf.d === 0 ? 2 : 0) + G.area[f] / (mesh.size * mesh.size);
    };
    for (let f = 0; f < nf; f++) { const sc = score(f); if (sc > best) { best = sc; root = f; } }
    if (root < 0) root = 0;
    const rigid = new Uint8Array(ne), w = new Float64Array(ne);
    const ra = new Float64Array(ne), rb = new Float64Array(ne), rm = new Float64Array(ne);
    let changes = false;
    G.edges.forEach((e, k) => {
      let made = false;
      let sa = 0, sb = 0, sm = 0;
      for (const h of e.hinges) {
        if (born[h] <= now) made = true;
        sa += A.a[si][h]; sb += A.b[si][h]; sm += A.mid?.[si][h] ?? 0;
      }
      const c = e.hinges.length;
      ra[k] = sa / c; rb[k] = sb / c; rm[k] = sm / c;
      if (!made) { rigid[k] = 1; return; }
      const moving = ra[k] !== rb[k] || (A.kind === 'crease' && rm[k] !== 0);
      if (moving) changes = true;
      // In a refold (a squash, a petal fold) the creases that are not named keep the paper folded
      // flat, as fingers do: they hold firm, and only the named creases give. With `firm`, layers
      // folded flat on each other are held together the same way while a model is shaped.
      const hold = ph.motion === 'refold' || (firm && Math.abs(Math.abs(ra[k]) - Math.PI) < 1e-6);
      w[k] = moving ? 1 : hold ? 20 : 0.35;
    });
    const T = buildTree(G, root, rigid);
    // Flaps that move independently, so they can be folded one after another if they would collide:
    // changing creases that touch the same moving face, or lie close together in the starting pose.
    const parentU = new Int32Array(ne + nf).map((_, i) => i);
    const find = (x: number): number => { while (parentU[x] !== x) { parentU[x] = parentU[parentU[x]]; x = parentU[x]; } return x; };
    const isFixed = (f: number) => f === root || !!ph.faces[match[f]]?.k;
    const movingEdges: number[] = [];
    G.edges.forEach((e, k) => {
      if (rigid[k] || !(ra[k] !== rb[k] || (A.kind === 'crease' && rm[k] !== 0))) return;
      movingEdges.push(k);
      for (const f of [e.F, e.G]) if (!isFixed(f)) parentU[find(k)] = find(ne + f);
    });
    const seg = movingEdges.map((k) => {
      const e = G.edges[k], P = new Float64Array(6);
      applyXf(X0, 12 * e.F, e.a[0], e.a[1], P, 0);
      applyXf(X0, 12 * e.F, e.b[0], e.b[1], P, 3);
      return P;
    });
    const near = mesh.size * 0.12;
    for (let i = 0; i < movingEdges.length; i++) for (let j = i + 1; j < movingEdges.length; j++) {
      if (segDist3(seg[i], seg[j]) < near) parentU[find(movingEdges[i])] = find(movingEdges[j]);
    }
    const comp = new Map<number, number[]>();
    for (const k of movingEdges) { const c = find(k); comp.set(c, [...(comp.get(c) ?? []), k]); }
    const groups = [...comp.values()].sort((x, y) => x[0] - y[0]).map((g, i) => i);
    const groupOf = new Int32Array(ne).fill(-1);
    [...comp.values()].sort((x, y) => x[0] - y[0]).forEach((g, i) => { for (const k of g) groupOf[k] = i; });
    // Per-edge time window (start, length) when the groups are folded one after another.
    const win0 = new Float64Array(ne), win1 = new Float64Array(ne).fill(1);
    if (order && order.length > 1) {
      order.forEach((gi, slot) => {
        for (let k = 0; k < ne; k++) if (groupOf[k] === gi) { win0[k] = slot / order.length; win1[k] = 1 / order.length; }
      });
    }
    const local = (k: number, t: number) => Math.max(0, Math.min(1, (t - win0[k]) / win1[k]));
    const theta = new Float64Array(ne);
    for (const k of T.vars) theta[k] = measure(X0, G.edges[k], ra[k]);
    const rootFace = ph.faces[match[root]];
    const root0 = X0.slice(12 * root, 12 * root + 12);
    const moves = !!rootFace && (ph.motion === 'spin' || ph.motion === 'move' || ph.motion === 'chain' || rootFace.d !== 0);
    const rho = new Float64Array(ne);
    const tg: SolveTargets = { rho, w, rigid };
    const syms = changes && !moves && !order && T.vars.length <= 200
      ? findSymmetries(G, X0, root, (k) => rigid[k] ? 'r' : `${ra[k].toFixed(9)} ${rb[k].toFixed(9)} ${rm[k].toFixed(9)} ${w[k]}`,
        (k) => !rigid[k] && (ra[k] !== rb[k] || (A.kind === 'crease' && rm[k] !== 0)))
      : [];
    const extra = symmetryPairs(G, syms);
    this.symmetries[si] = syms.length;
    const solveAt = (t: number, out: Float64Array): number => {
      if (A.kind === 'crease') {
        for (let k = 0; k < ne; k++) rho[k] = ra[k] + (rm[k] - ra[k]) * 0.9 * (0.5 - 0.5 * Math.cos(2 * Math.PI * local(k, t)));
      } else {
        for (let k = 0; k < ne; k++) rho[k] = ra[k] + (rb[k] - ra[k]) * easeCos(local(k, t));
      }
      const D = rootFace && moves ? faceMotion(ph, rootFace, t) : ID;
      const rootXf = new Float64Array(12);
      compose(D, root0, rootXf);
      if (!changes) {
        // Only a rigid move: carry every face along.
        for (let f = 0; f < nf; f++) compose(D, X0.subarray(12 * f, 12 * f + 12), out, 12 * f);
        return 0;
      }
      return solvePose(G, T, rootXf, tg, theta, out, 12, extra);
    };
    /** Largest miss (radians) between a moving crease's angle in pose X and its target at the end. */
    const miss = (X: Float64Array): number => {
      let mx = 0;
      G.edges.forEach((e, k) => {
        if (rigid[k] || w[k] < 1 || A.kind === 'crease') return;
        mx = Math.max(mx, Math.abs(measure(X, e, rb[k]) - rb[k]));
      });
      return mx;
    };
    return { changes, moves, solveAt, unknowns: T.vars.length, groups, miss };
  }

  /** Exact flat-fold pose of a phase (before, after, or at time t of its rigid motion), per sheet. */
  flatPose(ph: Phase, A: PhaseAnglesLike, at: "a" | "b" | number): Float64Array[] {
    return this.graphs.map((G, si) => {
      const nf = G.mesh.faces.length, X = new Float64Array(12 * nf);
      for (let f = 0; f < nf; f++) {
        const fi = A.match[si][f], pf = fi >= 0 ? ph.faces[fi] : null;
        if (!pf) { X.set(ID, 12 * f); continue; }
        if (at === 'a' || at === 'b') { X.set(lift(at === 'a' ? pf.a : pf.b), 12 * f); continue; }
        compose(faceMotion(ph, pf, at), lift(pf.a), X, 12 * f);
      }
      return X;
    });
  }

  /** Positions (paper-world cm, 3 per mesh vertex) of sheet si from face transforms X. */
  positions(si: number, X: Float64Array, out?: Float64Array): Float64Array {
    const mesh = this.graphs[si].mesh, n = mesh.n;
    const P = out ?? new Float64Array(3 * n);
    for (let i = 0; i < n; i++) {
      const f = mesh.vertFace[i];
      applyXf(X, 12 * Math.max(0, f), mesh.paper[2 * i], mesh.paper[2 * i + 1], P, 3 * i);
    }
    return P;
  }

  /** Works out every step and packs the result for the browser (see KinRecord). */
  record(): KinRecord {
    const steps = this.model.steps.map((step, s) => {
      this.ensureStep(s);
      const L = this.levels[s]!, nf = this.graphs.map((G) => G.mesh.faces.length);
      const lv = new Int16Array(L.length * nf.reduce((a, b) => a + b, 0));
      let o = 0;
      for (const rest of L) rest.forEach((x) => { for (let f = 0; f < x.length; f++) lv[o++] = Math.round(x[f]); });
      const out: KinRecord['steps'][number] = { tier: this.tier[s], spans: this.spans[s], missed: +this.missed[s].toFixed(3), levels: b64(new Uint8Array(lv.buffer)) };
      if (this.solved(s)) {
        const F = this.frames[s]!;
        const X = new Float32Array(F.length * nf.reduce((a, b) => a + b, 0) * 7);
        const flip = new Int8Array(nf.reduce((a, b) => a + b, 0));
        let k = 0, j = 0;
        F[0].X.forEach((Xs) => { for (let f = 0; f < Xs.length / 12; f++) flip[j++] = detOf(Xs, 12 * f) < 0 ? 1 : 0; });
        for (const fr of F) fr.X.forEach((Xs) => {
          for (let f = 0; f < Xs.length / 12; f++) {
            const o12 = 12 * f, sg = detOf(Xs, o12) < 0 ? -1 : 1;
            const R = [Xs[o12], Xs[o12 + 1], Xs[o12 + 2] * sg, Xs[o12 + 3], Xs[o12 + 4], Xs[o12 + 5] * sg, Xs[o12 + 6], Xs[o12 + 7], Xs[o12 + 8] * sg];
            const q = quatOf(R);
            if (q[0] < 0) for (let c = 0; c < 4; c++) q[c] = -q[c];
            X.set([q[0], q[1], q[2], q[3], Xs[o12 + 9], Xs[o12 + 10], Xs[o12 + 11]], k);
            k += 7;
          }
        });
        out.frames = { t: F.map((fr) => +fr.t.toFixed(6)), X: b64(new Uint8Array(X.buffer)), flip: b64(new Uint8Array(flip.buffer)) };
        const S = this.soft[s];
        if (S) {
          const nv = this.meshes.reduce((a, m) => a + m.n, 0), buf = new Float32Array(S.length * nv * 3);
          let o2 = 0;
          for (const fr of S) for (const Q of fr) { buf.set(Q, o2); o2 += Q.length; }
          out.soft = b64(new Uint8Array(buf.buffer));
        }
      }
      return out;
    });
    return { v: 1, faces: this.graphs.map((G) => G.mesh.faces.length), steps };
  }

  /** Uses steps solved at build time. Ignored when it doesn't match this model's meshes. */
  load(rec: KinRecord | undefined) {
    if (!rec || rec.v !== 1 || rec.steps.length !== this.model.steps.length) return;
    if (rec.faces.length !== this.graphs.length || rec.faces.some((n, si) => n !== this.graphs[si].mesh.faces.length)) return;
    this.rec = rec.steps;
  }

  /** True for steps that need the solver (not plain folds of flat paper), which are recorded in full. */
  private solved(s: number): boolean {
    return this.shapedBefore(s) || this.model.steps[s].phases.some((p) => p.motion === 'chain' || p.motion === 'refold' || p.motion === 'shape' || p.motion === 'pose');
  }

  private recLevels(s: number): Float32Array[][] {
    const r = this.rec![s], v = new Int16Array(unb64(r.levels).buffer);
    const nf = this.graphs.map((G) => G.mesh.faces.length), per = nf.reduce((a, b) => a + b, 0);
    const out: Float32Array[][] = [];
    for (let o = 0; o + per <= v.length; o += per) {
      let k = o;
      out.push(nf.map((n) => { const x = new Float32Array(n); for (let f = 0; f < n; f++) x[f] = v[k++]; return x; }));
    }
    return out;
  }

  /** Takes step s from the build-time record instead of solving it. */
  private adopt(s: number) {
    const r = this.rec![s], fr = r.frames!;
    const nf = this.graphs.map((G) => G.mesh.faces.length);
    const X = new Float32Array(unb64(fr.X).buffer), flip = new Int8Array(unb64(fr.flip).buffer);
    let k = 0;
    this.frames[s] = fr.t.map((t) => {
      let j = 0;
      return { t, X: nf.map((n) => {
        const out = new Float64Array(12 * n);
        for (let f = 0; f < n; f++, j++, k += 7) {
          const R = quatToR([X[k], X[k + 1], X[k + 2], X[k + 3]]), sg = flip[j] ? -1 : 1;
          out.set([R[0], R[1], R[2] * sg, R[3], R[4], R[5] * sg, R[6], R[7], R[8] * sg, X[k + 4], X[k + 5], X[k + 6]], 12 * f);
        }
        return out;
      }) };
    });
    if (r.soft) {
      const buf = new Float32Array(unb64(r.soft).buffer);
      let o2 = 0;
      this.soft[s] = fr.t.map(() => this.meshes.map((m) => { const Q = Float64Array.from(buf.subarray(o2, o2 + 3 * m.n)); o2 += 3 * m.n; return Q; }));
      this.softStart[s + 1] = this.soft[s]!.at(-1)!;
    }
    this.tier[s] = r.tier;
    this.spans[s] = r.spans;
    this.missed[s] = r.missed;
    this.crossed[s] = r.tier === 'crossing' ? 1 : 0;
    this.gap[s] = 0;
    this.levels[s] = this.recLevels(s);
    const end = this.frames[s]!.at(-1)!.X;
    this.start[s + 1] = this.shapedBefore(s + 1) ? end.map((x) => x.slice()) : this.flatStart(s + 1);
  }

  /** What the flat diagram says at rest pose r of step s (r = phase index; r = phases for the end). */
  private flatInfo(s: number, r: number, si: number): FlatInfo | null {
    const phases = this.model.steps[s]?.phases ?? [];
    if (!phases.length) return null;
    const p = Math.min(r, phases.length - 1), which = r < phases.length ? 'a' : 'b';
    const ph = phases[p], match = this.angles[s][p].match[si];
    const nf = this.graphs[si].mesh.faces.length;
    const F = new Float64Array(12 * nf), layer = new Float64Array(nf).fill(NaN);
    for (let f = 0; f < nf; f++) {
      const pf = match[f] >= 0 ? ph.faces[match[f]] : null;
      if (!pf) { F.set(ID, 12 * f); continue; }
      F.set(lift(which === 'a' ? pf.a : pf.b), 12 * f);
      layer[f] = which === 'a' ? pf.la : pf.lb;
    }
    return { F, layer };
  }

  /**
   * Works out the paper thickness for step s: the level of every face at each rest pose. Motions
   * that bring faces together in 3D are watched frame by frame, so faces that meet keep the side
   * they came from.
   */
  private stackStep(s: number, frames: KinFrame[]) {
    const phases = this.model.steps[s].phases, np = Math.max(1, phases.length);
    const sides = this.graphs.map((_, si) => new Map(this.sides[s]?.[si] ?? []));
    const watch = this.shapedBefore(s) || phases.some((p) => p.motion === 'shape' || p.motion === 'chain' || p.motion === 'refold');
    const out: Float32Array[][] = [];
    let j = 0;
    for (let r = 0; r <= np; r++) {
      const t = r / np;
      if (watch) for (; j < frames.length && frames[j].t < t - 1e-9; j++) frames[j].X.forEach((X, si) => recordSides(this.graphs[si].mesh, this.positions(si, X), sides[si]));
      const X = this.frameAt(s, t);
      out.push(X.map((Xs, si) => stackLevels(this.graphs[si].mesh, this.positions(si, Xs), Xs, this.flatInfo(s, r, si), sides[si])));
    }
    this.levels[s] = out;
    this.sides[s + 1] = sides;
  }

  /** Level of each face (see `levels`) at time t through step s, per sheet. */
  levelsAt(s: number, t: number): Float32Array[] {
    if (s >= this.model.steps.length) { s = this.model.steps.length - 1; t = 1; }
    this.ensureStep(s);
    const L = this.levels[s]!, np = L.length - 1;
    const x = Math.max(0, Math.min(1, t)) * np, p = Math.min(np - 1, Math.floor(x));
    const e = easeCos(x - p);
    if (e <= 0) return L[p];
    if (e >= 1) return L[p + 1];
    return L[p].map((a, si) => { const b = L[p + 1][si], o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] + (b[i] - a[i]) * e; return o; });
  }

  /** Face transforms at time t (0..1) through step s, blended between the two nearest frames. */
  frameAt(s: number, t: number): Float64Array[] {
    if (s >= this.model.steps.length) return this.stateAt(s);
    this.ensureStep(s);
    const F = this.frames[s]!;
    let j = 0;
    while (j < F.length - 1 && F[j + 1].t <= t) j++;
    const a = F[j], b = F[Math.min(F.length - 1, j + 1)];
    const w = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
    if (w <= 0) return a.X;
    if (w >= 1) return b.X;
    return a.X.map((xa, si) => blendXf(xa, b.X[si], w));
  }
}

/** Per face: rotation by slerp, translation linearly (keeps every face rigid between frames). */
export function blendXf(A: Float64Array, B: Float64Array, w: number): Float64Array {
  const out = new Float64Array(A.length);
  for (let o = 0; o < A.length; o += 12) {
    // A face being reshaped (not a rigid move) has no rotation to slerp: blend it directly.
    const da = detOf(A, o), db = detOf(B, o);
    if (Math.abs(Math.abs(da) - 1) > 1e-3 || Math.abs(Math.abs(db) - 1) > 1e-3) {
      for (let k = 0; k < 12; k++) out[o + k] = A[o + k] + (B[o + k] - A[o + k]) * w;
      continue;
    }
    const D = new Float64Array(12);
    compose(B.subarray(o, o + 12), invert(A.subarray(o, o + 12)), D);
    // Turn about the face's own centre-ish (its origin image), not the world origin.
    const P = partial(Array.from(D), w);
    // partial() lerps D's translation, which is right for a rotation about the world origin; good
    // enough between close frames.
    compose(P, A.subarray(o, o + 12), out, o);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Crossing check: do any two pieces of paper pass through each other?

/**
 * Pairs of triangles that pierce each other in a pose (positions 3 per mesh vertex). Triangles that
 * share a vertex (neighbours along a crease) and layers lying flat on each other are not crossings.
 * `eps` is the depth (cm) a piercing must reach to count, so touching and rounding are ignored.
 */
export function crossings(mesh: SimMesh, P: ArrayLike<number>, eps = mesh.size * 2e-3, limit = 50): [number, number][] {
  const T = mesh.tris, nt = T.length / 3;
  const box = new Float64Array(6 * nt);
  for (let t = 0; t < nt; t++) {
    for (let c = 0; c < 3; c++) {
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < 3; k++) { const v = P[3 * T[3 * t + k] + c]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
      box[6 * t + c] = lo - eps; box[6 * t + 3 + c] = hi + eps;
    }
  }
  const order = Array.from({ length: nt }, (_, i) => i).sort((a, b) => box[6 * a] - box[6 * b]);
  const out: [number, number][] = [];
  for (let i = 0; i < nt && out.length < limit; i++) {
    const a = order[i];
    for (let j = i + 1; j < nt; j++) {
      const b = order[j];
      if (box[6 * b] > box[6 * a + 3]) break;
      if (box[6 * b + 1] > box[6 * a + 4] || box[6 * a + 1] > box[6 * b + 4] || box[6 * b + 2] > box[6 * a + 5] || box[6 * a + 2] > box[6 * b + 5]) continue;
      if (mesh.triFace[a] === mesh.triFace[b]) continue;
      let share = false;
      for (let x = 0; x < 3 && !share; x++) for (let y = 0; y < 3; y++) if (T[3 * a + x] === T[3 * b + y]) { share = true; break; }
      if (share) continue;
      if (triPierce(P, T, a, b, eps) || triPierce(P, T, b, a, eps)) out.push([a, b]);
    }
  }
  return out;
}

/** Whether an edge of triangle a passes through the inside of triangle b by more than eps. */
function triPierce(P: ArrayLike<number>, T: Uint32Array, a: number, b: number, eps: number): boolean {
  const v = (i: number, c: number) => P[3 * T[3 * b + i] + c];
  const ox = v(0, 0), oy = v(0, 1), oz = v(0, 2);
  const e1 = [v(1, 0) - ox, v(1, 1) - oy, v(1, 2) - oz], e2 = [v(2, 0) - ox, v(2, 1) - oy, v(2, 2) - oz];
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const nl = Math.hypot(n[0], n[1], n[2]);
  if (nl < 1e-12) return false;
  n[0] /= nl; n[1] /= nl; n[2] /= nl;
  const d = (i: number) => { const w = 3 * T[3 * a + i]; return (P[w] - ox) * n[0] + (P[w + 1] - oy) * n[1] + (P[w + 2] - oz) * n[2]; };
  const ds = [d(0), d(1), d(2)];
  for (let k = 0; k < 3; k++) {
    const p = 3 * T[3 * a + k], q = 3 * T[3 * a + ((k + 1) % 3)];
    const dp = ds[k], dq = ds[(k + 1) % 3];
    // A real crossing: the edge goes clearly from one side of the plane to the other.
    if (!((dp > eps && dq < -eps) || (dp < -eps && dq > eps))) continue;
    const s = dp / (dp - dq);
    const x = P[p] + (P[q] - P[p]) * s - ox, y = P[p + 1] + (P[q + 1] - P[p + 1]) * s - oy, z = P[p + 2] + (P[q + 2] - P[p + 2]) * s - oz;
    // Barycentric coordinates in b, with a margin of eps inside the edges.
    const d00 = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2], d01 = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2], d11 = e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2];
    const d20 = x * e1[0] + y * e1[1] + z * e1[2], d21 = x * e2[0] + y * e2[1] + z * e2[2];
    const den = d00 * d11 - d01 * d01;
    if (Math.abs(den) < 1e-18) continue;
    const vv = (d11 * d20 - d01 * d21) / den, ww = (d00 * d21 - d01 * d20) / den, uu = 1 - vv - ww;
    const m = eps / Math.sqrt(Math.max(d00, d11));
    if (uu > m && vv > m && ww > m) return true;
  }
  return false;
}
