// Paper simulation in the style of Origami Simulator (Ghassaei et al. 2018).
//
// Each sheet becomes one connected triangle mesh built from the finest crease
// pattern of the model. Bars keep edge lengths, hinges drive the fold angle of
// each crease towards a target, and facet hinges keep faces flat but allow a
// little bending. The flat-fold engine says which way and how far each crease
// should be folded at every phase; the solver finds a physical shape for it.
//
// Pure TypeScript with no three.js, so it runs in the browser, in workers and in tests.

import type { CompiledModel, Phase, PhaseFace } from './types.ts';
import { applyShapes } from './shape.ts';

type V2 = [number, number];

export interface SimMesh {
  sheet: string;
  /** Number of vertices. */
  n: number;
  /** Paper coordinates (cm), 2 per vertex. */
  paper: Float64Array;
  /** Triangles (3 indices each), counter-clockwise in paper space so the normal is the front side. */
  tris: Uint32Array;
  /** Crease-pattern face of each triangle. */
  triFace: Int32Array;
  /** Bars: vertex pairs and rest lengths (cm). */
  bars: Uint32Array;
  barLen: Float64Array;
  /** Hinges: [a, b, c, d] per hinge. Edge a→b, wing c on the left (front-facing tri a,b,c), wing d on the right (tri b,a,d). */
  hinges: Uint32Array;
  /** 1 for a crease between two faces of the crease pattern, 0 for a facet diagonal. */
  hingeCrease: Uint8Array;
  hingeLen: Float64Array;
  /** Crease-pattern face (index into `faces`) on the left and right of each hinge. */
  hingeFaces: Int32Array;
  /** The crease-pattern faces (paper polygons) that make up this sheet. */
  faces: V2[][];
  /** A paper point inside each crease-pattern face, for matching it with a phase face. */
  faceSample: V2[];
  /** For each vertex, one crease-pattern face that contains it. */
  vertFace: Int32Array;
  /** Edges to draw: crease (1), boundary (2). Vertex pairs. */
  lines: Uint32Array;
  lineKind: Uint8Array;
  /** For each line, its hinge (creases) or -1 (paper edges). */
  lineHinge: Int32Array;
  /** Sheet size, used to normalise the solver. */
  size: number;
}

const unflat = (p: number[]): V2[] => {
  const out: V2[] = [];
  for (let i = 0; i < p.length; i += 2) out.push([p[i], p[i + 1]]);
  return out;
};
const area2 = (poly: V2[]) => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a;
};
function segDist(x: V2, a: V2, b: V2): { d: number; t: number } {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const l2 = abx * abx + aby * aby;
  const t = l2 < 1e-18 ? 0 : ((x[0] - a[0]) * abx + (x[1] - a[1]) * aby) / l2;
  const tc = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(x[0] - a[0] - abx * tc, x[1] - a[1] - aby * tc), t };
}
export function insidePoly(poly: V2[], x: V2, tol = 1e-6): boolean {
  // Convex polygon, either orientation.
  const s = Math.sign(area2(poly));
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const c = (b[0] - a[0]) * (x[1] - a[1]) - (b[1] - a[1]) * (x[0] - a[0]);
    if (c * s < -tol) return false;
  }
  return true;
}

/** Builds one mesh per sheet from the finest faces the model ever has (its final state). */
export function buildSimMeshes(model: CompiledModel): SimMesh[] {
  let final: PhaseFace[] = [];
  for (let i = model.steps.length - 1; i >= 0 && !final.length; i--) {
    const ph = model.steps[i].phases;
    if (ph.length) final = ph[ph.length - 1].faces;
  }
  const out: SimMesh[] = [];
  for (const sheet of model.sheets) {
    let polys = final.filter((f) => f.s === sheet.id).map((f) => unflat(f.p));
    if (!polys.length) polys = [[[0, 0], [sheet.w, 0], [sheet.w, sheet.h], [0, sheet.h]]];
    out.push(buildMesh(sheet.id, polys, Math.max(sheet.w, sheet.h)));
  }
  return out;
}

export function buildMesh(sheet: string, polys0: V2[][], size: number): SimMesh {
  const tol = size * 2e-5;
  const verts: V2[] = [];
  const grid = new Map<string, number[]>();
  const cell = tol * 4;
  const keyOf = (x: number, y: number) => `${Math.round(x / cell)},${Math.round(y / cell)}`;
  const vid = (p: V2): number => {
    const cx = Math.round(p[0] / cell), cy = Math.round(p[1] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (Math.hypot(verts[i][0] - p[0], verts[i][1] - p[1]) < tol) return i;
      }
    }
    verts.push([p[0], p[1]]);
    const k = keyOf(p[0], p[1]);
    grid.set(k, [...(grid.get(k) ?? []), verts.length - 1]);
    return verts.length - 1;
  };
  const polys = polys0.map((p) => (area2(p) < 0 ? p.slice().reverse() : p)).filter((p) => Math.abs(area2(p)) > tol * tol);
  const idx = polys.map((p) => p.map(vid));
  // Fix T-junctions: put every vertex that lies on a polygon edge into that edge.
  const nCorner = verts.length;
  const full: number[][] = idx.map((ring) => {
    const res: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      res.push(a);
      const mids: { v: number; t: number }[] = [];
      for (let v = 0; v < nCorner; v++) {
        if (v === a || v === b) continue;
        const r = segDist(verts[v], verts[a], verts[b]);
        if (r.d < tol && r.t > 1e-6 && r.t < 1 - 1e-6) mids.push({ v, t: r.t });
      }
      mids.sort((x, y) => x.t - y.t);
      for (const m of mids) res.push(m.v);
    }
    // Drop repeats.
    return res.filter((v, i) => v !== res[(i + 1) % res.length]);
  });

  // Triangulate each face as a fan around its centre (handles collinear points cleanly).
  const tris: number[] = [];
  const triFace: number[] = [];
  const faceSample: V2[] = [];
  full.forEach((ring, fi) => {
    let cx = 0, cy = 0;
    for (const v of ring) { cx += verts[v][0]; cy += verts[v][1]; }
    cx /= ring.length; cy /= ring.length;
    faceSample.push([cx, cy]);
    if (ring.length === 3) {
      tris.push(ring[0], ring[1], ring[2]);
      triFace.push(fi);
      return;
    }
    verts.push([cx, cy]);
    const c = verts.length - 1;
    for (let i = 0; i < ring.length; i++) {
      tris.push(c, ring[i], ring[(i + 1) % ring.length]);
      triFace.push(fi);
    }
  });

  // Edges, bars and hinges.
  const edgeMap = new Map<string, { a: number; b: number; wings: { tri: number; opp: number; dir: number }[] }>();
  for (let t = 0; t < tris.length / 3; t++) {
    const v = [tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3], opp = v[(k + 2) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const e = edgeMap.get(key) ?? { a: Math.min(a, b), b: Math.max(a, b), wings: [] };
      // dir 1: the triangle runs a→b (min→max), so its opposite vertex is on the left of min→max.
      e.wings.push({ tri: t, opp, dir: a < b ? 1 : -1 });
      edgeMap.set(key, e);
    }
  }
  const bars: number[] = [], barLen: number[] = [];
  const hinges: number[] = [], hingeCrease: number[] = [], hingeLen: number[] = [], hingeFaces: number[] = [];
  const lines: number[] = [], lineKind: number[] = [], lineHinge: number[] = [];
  const L = (a: number, b: number) => Math.hypot(verts[a][0] - verts[b][0], verts[a][1] - verts[b][1]);
  for (const e of edgeMap.values()) {
    bars.push(e.a, e.b);
    barLen.push(L(e.a, e.b));
    if (e.wings.length === 2) {
      const left = e.wings.find((w) => w.dir === 1) ?? e.wings[0];
      const right = e.wings.find((w) => w !== left)!;
      hinges.push(e.a, e.b, left.opp, right.opp);
      const fl = triFace[left.tri], fr = triFace[right.tri];
      const crease = fl !== fr ? 1 : 0;
      hingeCrease.push(crease);
      hingeLen.push(L(e.a, e.b));
      hingeFaces.push(fl, fr);
      if (crease) { lines.push(e.a, e.b); lineKind.push(1); lineHinge.push(hingeCrease.length - 1); }
    } else if (e.wings.length === 1) {
      lines.push(e.a, e.b);
      lineKind.push(2);
      lineHinge.push(-1);
    }
  }
  // Shear bars across each pair of triangles in a face keep facets from collapsing in-plane.
  const vertFace = new Int32Array(verts.length).fill(-1);
  for (let t = 0; t < triFace.length; t++) for (let k = 0; k < 3; k++) if (vertFace[tris[3 * t + k]] < 0) vertFace[tris[3 * t + k]] = triFace[t];

  const paper = new Float64Array(verts.length * 2);
  verts.forEach((p, i) => { paper[2 * i] = p[0]; paper[2 * i + 1] = p[1]; });
  return {
    sheet, n: verts.length, paper,
    tris: Uint32Array.from(tris), triFace: Int32Array.from(triFace),
    bars: Uint32Array.from(bars), barLen: Float64Array.from(barLen),
    hinges: Uint32Array.from(hinges), hingeCrease: Uint8Array.from(hingeCrease), hingeLen: Float64Array.from(hingeLen),
    hingeFaces: Int32Array.from(hingeFaces),
    faces: full.map((ring) => ring.map((v) => verts[v])), faceSample,
    vertFace, lines: Uint32Array.from(lines), lineKind: Uint8Array.from(lineKind), lineHinge: Int32Array.from(lineHinge), size,
  };
}

// ---------------------------------------------------------------------------
// Fold angles from flat-fold states

const det = (m: number[]) => m[0] * m[3] - m[1] * m[2];
const sameM = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);

/** For each crease-pattern face of the mesh, the index of the phase face that contains it. */
export function matchFaces(mesh: SimMesh, faces: PhaseFace[]): Int32Array {
  const mine = faces.map((f, i) => ({ f, i, poly: unflat(f.p) })).filter((x) => x.f.s === mesh.sheet);
  const out = new Int32Array(mesh.faces.length).fill(-1);
  mesh.faceSample.forEach((p, k) => {
    let best = -1;
    for (const x of mine) if (insidePoly(x.poly, p, 1e-5)) { best = x.i; break; }
    if (best < 0) {
      // Fall back to the nearest face centre.
      let bd = Infinity;
      for (const x of mine) {
        let cx = 0, cy = 0;
        for (const q of x.poly) { cx += q[0]; cy += q[1]; }
        const d = Math.hypot(cx / x.poly.length - p[0], cy / x.poly.length - p[1]);
        if (d < bd) { bd = d; best = x.i; }
      }
    }
    out[k] = best;
  });
  return out;
}

/**
 * Target fold angle of every hinge for a flat state: 0 if flat, ±π if folded.
 * Negative is a valley seen from the front of the paper (the wings rise towards the front normal).
 * `which` picks the before (a) or after (b) arrangement of the phase faces.
 */
export function flatAngles(mesh: SimMesh, faces: PhaseFace[], match: Int32Array, which: 'a' | 'b'): Float64Array {
  const nh = mesh.hingeCrease.length;
  const out = new Float64Array(nh);
  for (let h = 0; h < nh; h++) {
    if (!mesh.hingeCrease[h]) continue;
    const F = faces[match[mesh.hingeFaces[2 * h]]], G = faces[match[mesh.hingeFaces[2 * h + 1]]];
    if (!F || !G || F === G) continue;
    const mF = which === 'a' ? F.a : F.b, mG = which === 'a' ? G.a : G.b;
    if (sameM(mF, mG)) continue;
    const lF = which === 'a' ? F.la : F.lb, lG = which === 'a' ? G.la : G.lb;
    const valley = (det(mF) > 0) === (lG > lF);
    out[h] = valley ? -Math.PI : Math.PI;
  }
  return out;
}

/** Overrides `out` for hinges on the authored crease lines of a collapse (chain) phase. */
export function chainAngles(mesh: SimMesh, ph: Phase, match: Int32Array, out: Float64Array) {
  const nh = mesh.hingeCrease.length;
  for (let h = 0; h < nh; h++) {
    if (!mesh.hingeCrease[h]) continue;
    const F = ph.faces[match[mesh.hingeFaces[2 * h]]];
    if (!F) continue;
    const ia = mesh.hinges[4 * h], ib = mesh.hinges[4 * h + 1];
    const m = F.a;
    const pa: V2 = [m[0] * mesh.paper[2 * ia] + m[2] * mesh.paper[2 * ia + 1] + m[4], m[1] * mesh.paper[2 * ia] + m[3] * mesh.paper[2 * ia + 1] + m[5]];
    const pb: V2 = [m[0] * mesh.paper[2 * ib] + m[2] * mesh.paper[2 * ib + 1] + m[4], m[1] * mesh.paper[2 * ib] + m[3] * mesh.paper[2 * ib + 1] + m[5]];
    const line = ph.lines.find((l) => l.kind !== 'crease' && onSeg(pa, l.p, l.q) && onSeg(pb, l.p, l.q));
    if (!line) continue;
    const frontUp = det(m) > 0;
    const towardFront = line.kind === 'valley' ? frontUp : !frontUp;
    out[h] = towardFront ? -Math.PI : Math.PI;
  }
}

function onSeg(p: V2, a: V2, b: V2): boolean {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
  if (t < -1e-4 || t > 1 + 1e-4) return false;
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) < 1e-4 * Math.sqrt(L2) + 1e-6;
}

/** Fold angles at the middle of a "crease" phase (fold and unfold): the creased hinges fold one way. */
export function creaseAngles(mesh: SimMesh, faces: PhaseFace[], match: Int32Array): Float64Array {
  const nh = mesh.hingeCrease.length;
  const out = new Float64Array(nh);
  for (let h = 0; h < nh; h++) {
    if (!mesh.hingeCrease[h]) continue;
    const F = faces[match[mesh.hingeFaces[2 * h]]], G = faces[match[mesh.hingeFaces[2 * h + 1]]];
    if (!F || !G || F === G || (F.d === 0) === (G.d === 0)) continue;
    const mover = F.d !== 0 ? F : G;
    const valley = (det(mover.a) > 0) === (mover.d > 0);
    out[h] = valley ? -Math.PI : Math.PI;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Solver

export interface SolverOptions {
  axial?: number;
  crease?: number;
  facet?: number;
  damping?: number;
}

export class Solver {
  mesh: SimMesh;
  /** Positions (normalised units: sheet size = 1), 3 per vertex. */
  x: Float64Array;
  v: Float64Array;
  f: Float64Array;
  target: Float64Array;
  theta: Float64Array;
  kBar: Float64Array;
  cBar: Float64Array;
  kHinge: Float64Array;
  restLen: Float64Array;
  dt: number;
  /** Largest vertex speed in the last iteration. */
  speed = 0;
  /** Velocity kept per iteration (1 = none lost). Raised while settling. */
  drag = 0.9995;

  constructor(mesh: SimMesh, opt: SolverOptions = {}) {
    this.mesh = mesh;
    const n = mesh.n, s = mesh.size;
    this.x = new Float64Array(3 * n);
    this.v = new Float64Array(3 * n);
    this.f = new Float64Array(3 * n);
    this.reset();
    const nb = mesh.barLen.length, nh = mesh.hingeLen.length;
    this.restLen = mesh.barLen.map((l) => l / s);
    const axial = opt.axial ?? 20, damping = opt.damping ?? 0.45;
    this.kBar = new Float64Array(nb);
    this.cBar = new Float64Array(nb);
    let kMax = 0;
    for (let i = 0; i < nb; i++) {
      const k = axial / Math.max(this.restLen[i], 0.01);
      this.kBar[i] = k;
      this.cBar[i] = 2 * damping * Math.sqrt(k);
      kMax = Math.max(kMax, k);
    }
    this.kHinge = new Float64Array(nh);
    for (let h = 0; h < nh; h++) this.kHinge[h] = (mesh.hingeCrease[h] ? opt.crease ?? 0.7 : opt.facet ?? 0.15) * (mesh.hingeLen[h] / s);
    this.target = new Float64Array(nh);
    this.theta = new Float64Array(nh);
    this.dt = 0.9 / (2 * Math.PI * Math.sqrt(kMax));
  }

  reset() {
    const { n, paper, size } = this.mesh;
    for (let i = 0; i < n; i++) {
      this.x[3 * i] = paper[2 * i] / size;
      this.x[3 * i + 1] = paper[2 * i + 1] / size;
      this.x[3 * i + 2] = 0;
    }
    this.v.fill(0);
    if (this.theta) this.theta.fill(0);
  }

  getState(): { x: Float64Array; theta: Float64Array } {
    return { x: this.x.slice(), theta: this.theta.slice() };
  }

  setState(s: { x: Float64Array; theta: Float64Array }) {
    this.x.set(s.x);
    this.theta.set(s.theta);
    this.v.fill(0);
  }

  /** Current dihedral angle of hinge h, unwrapped against the last value. */
  private angle(h: number, grad: Float64Array | null): number {
    const H = this.mesh.hinges, X = this.x;
    const a = H[4 * h], b = H[4 * h + 1], c = H[4 * h + 2], d = H[4 * h + 3];
    const ax = X[3 * a], ay = X[3 * a + 1], az = X[3 * a + 2];
    const ex = X[3 * b] - ax, ey = X[3 * b + 1] - ay, ez = X[3 * b + 2] - az;
    const cx = X[3 * c] - ax, cy = X[3 * c + 1] - ay, cz = X[3 * c + 2] - az;
    const dx = X[3 * d] - ax, dy = X[3 * d + 1] - ay, dz = X[3 * d + 2] - az;
    // n1 = e × c (left triangle a,b,c, front normal), n2 = d × e (right triangle b,a,d).
    const n1x = ey * cz - ez * cy, n1y = ez * cx - ex * cz, n1z = ex * cy - ey * cx;
    const n2x = dy * ez - dz * ey, n2y = dz * ex - dx * ez, n2z = dx * ey - dy * ex;
    const el = Math.hypot(ex, ey, ez) || 1e-12;
    const n1l2 = n1x * n1x + n1y * n1y + n1z * n1z || 1e-24, n2l2 = n2x * n2x + n2y * n2y + n2z * n2z || 1e-24;
    const n1l = Math.sqrt(n1l2), n2l = Math.sqrt(n2l2);
    const cosT = (n1x * n2x + n1y * n2y + n1z * n2z) / (n1l * n2l);
    // sin from (n1 × n2) · e
    const kx = n1y * n2z - n1z * n2y, ky = n1z * n2x - n1x * n2z, kz = n1x * n2y - n1y * n2x;
    const sinT = (kx * ex + ky * ey + kz * ez) / (n1l * n2l * el);
    let t = Math.atan2(sinT, cosT);
    const last = this.theta[h];
    let dlt = t - last;
    while (dlt > Math.PI) dlt -= 2 * Math.PI;
    while (dlt < -Math.PI) dlt += 2 * Math.PI;
    t = last + dlt;
    if (grad) {
      // Gradients of the dihedral angle (Bridson et al. 2003, in this vertex layout).
      const h1 = n1l / el, h2 = n2l / el; // heights of c and d above the edge
      const g1x = (-n1x / n1l) / h1, g1y = (-n1y / n1l) / h1, g1z = (-n1z / n1l) / h1;
      const g2x = (-n2x / n2l) / h2, g2y = (-n2y / n2l) / h2, g2z = (-n2z / n2l) / h2;
      const e2 = el * el;
      const tc = (cx * ex + cy * ey + cz * ez) / e2, td = (dx * ex + dy * ey + dz * ez) / e2;
      grad[0] = -((1 - tc) * g1x + (1 - td) * g2x); grad[1] = -((1 - tc) * g1y + (1 - td) * g2y); grad[2] = -((1 - tc) * g1z + (1 - td) * g2z);
      grad[3] = -(tc * g1x + td * g2x); grad[4] = -(tc * g1y + td * g2y); grad[5] = -(tc * g1z + td * g2z);
      grad[6] = g1x; grad[7] = g1y; grad[8] = g1z;
      grad[9] = g2x; grad[10] = g2y; grad[11] = g2z;
    }
    return t;
  }

  /** Measured fold angle of each hinge (for tests and diagnostics). */
  measure(): Float64Array {
    const out = new Float64Array(this.theta.length);
    for (let h = 0; h < out.length; h++) out[h] = this.angle(h, null);
    return out;
  }

  /** Runs `iters` time steps. Returns the largest speed seen at the end. */
  step(iters: number): number {
    const { bars, hinges } = this.mesh;
    const X = this.x, V = this.v, F = this.f;
    const nb = this.kBar.length, nh = this.kHinge.length, n3 = X.length;
    const g = new Float64Array(12);
    const dt = this.dt;
    for (let it = 0; it < iters; it++) {
      F.fill(0);
      for (let i = 0; i < nb; i++) {
        const a = bars[2 * i], b = bars[2 * i + 1];
        const dx = X[3 * b] - X[3 * a], dy = X[3 * b + 1] - X[3 * a + 1], dz = X[3 * b + 2] - X[3 * a + 2];
        const l = Math.hypot(dx, dy, dz) || 1e-12;
        const ux = dx / l, uy = dy / l, uz = dz / l;
        const rv = (V[3 * b] - V[3 * a]) * ux + (V[3 * b + 1] - V[3 * a + 1]) * uy + (V[3 * b + 2] - V[3 * a + 2]) * uz;
        const fm = this.kBar[i] * (l - this.restLen[i]) + this.cBar[i] * rv;
        F[3 * a] += fm * ux; F[3 * a + 1] += fm * uy; F[3 * a + 2] += fm * uz;
        F[3 * b] -= fm * ux; F[3 * b + 1] -= fm * uy; F[3 * b + 2] -= fm * uz;
      }
      for (let h = 0; h < nh; h++) {
        const t = this.angle(h, g);
        this.theta[h] = t;
        const tq = -this.kHinge[h] * (t - this.target[h]);
        for (let k = 0; k < 4; k++) {
          const v3 = 3 * hinges[4 * h + k];
          F[v3] += tq * g[3 * k]; F[v3 + 1] += tq * g[3 * k + 1]; F[v3 + 2] += tq * g[3 * k + 2];
        }
      }
      let mx = 0;
      for (let i = 0; i < n3; i++) {
        V[i] = (V[i] + F[i] * dt) * this.drag;
        X[i] += V[i] * dt;
        const s = Math.abs(V[i]);
        if (s > mx) mx = s;
      }
      this.speed = mx;
    }
    return this.speed;
  }
}

// ---------------------------------------------------------------------------
// Timeline: drives the solvers through the steps of a model.

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface PhaseAngles { kind: 'flat' | 'crease'; a: Float64Array[]; b: Float64Array[]; mid?: Float64Array[]; match: Int32Array[]; exA?: Uint8Array[]; exB?: Uint8Array[] }

export interface FoldSimOptions extends SolverOptions {
  /**
   * How far folds close at rest, by age: [the fold just made, the one before, older ones].
   * 1 is flat. Newer folds are left a little open, like real paper, and older ones are pressed flatter,
   * which also keeps nested folds from drifting away from the flat shape.
   */
  rest?: [number, number, number];
}

export class FoldSim {
  meshes: SimMesh[];
  solvers: Solver[];
  rest: [number, number, number];
  lastSettle = 0;
  /** lastAt[s][sheet][h]: the last step before step s that changed hinge h, or -1. */
  private lastAt: Int32Array[][] = [];
  /** angles[step][phase] */
  angles: PhaseAngles[][];
  /** State at the start of each step (index = step), and at the end (index = steps). */
  private cache: ({ x: Float64Array; theta: Float64Array }[] | undefined)[] = [];

  model: CompiledModel;

  constructor(model: CompiledModel, opt: FoldSimOptions = {}) {
    this.model = model;
    this.meshes = buildSimMeshes(model);
    this.solvers = this.meshes.map((m) => new Solver(m, opt));
    this.rest = opt.rest ?? [0.9, 0.99, 1];
    this.angles = model.steps.map((s) => s.phases.map((ph) => {
      const match = this.meshes.map((m) => matchFaces(m, ph.faces));
      const a = this.meshes.map((m, i) => flatAngles(m, ph.faces, match[i], 'a'));
      const b = this.meshes.map((m, i) => flatAngles(m, ph.faces, match[i], 'b'));
      if (ph.motion === 'chain') {
        // Collapses: the flat engine's stacking is only approximate, so take each crease's direction
        // from the authored mountain and valley lines instead.
        this.meshes.forEach((m, i) => chainAngles(m, ph, match[i], b[i]));
      }
      if (ph.motion === 'crease') {
        return { kind: 'crease' as const, a, b, match, mid: this.meshes.map((m, i) => creaseAngles(m, ph.faces, match[i])) };
      }
      return { kind: 'flat' as const, a, b, match } as PhaseAngles;
    }));
    // 3D shaping steps: creases held at in-between angles.
    applyShapes(model, this.meshes, this.angles);
    this.cache[0] = this.solvers.map((s) => s.getState());
    // Which step last changed each hinge, as of the start of every step.
    const N = model.steps.length;
    let cur = this.meshes.map((m) => new Int32Array(m.hingeLen.length).fill(-1));
    this.lastAt = [cur];
    for (let s = 0; s < N; s++) {
      const next = cur.map((x) => x.slice());
      for (const A of this.angles[s]) {
        A.a.forEach((a, i) => {
          const b = A.b[i], m = A.mid?.[i];
          for (let h = 0; h < a.length; h++) if (a[h] !== b[h] || (m && m[h] !== 0)) next[i][h] = s;
        });
      }
      this.lastAt.push(next);
      cur = next;
    }
  }

  /**
   * For each hinge of sheet i, when it is first folded, encoded as step * 64 + phase (or a large
   * number if never).
   */
  creaseBorn(i: number): Int32Array {
    const nh = this.meshes[i].hingeLen.length, out = new Int32Array(nh).fill(1 << 30);
    this.angles.forEach((phases, s) => phases.forEach((A, p) => {
      const a = A.a[i], b = A.b[i], m = A.mid?.[i];
      for (let h = 0; h < nh; h++) {
        if ((a[h] !== b[h] || (m && m[h] !== 0)) && out[h] > s * 64 + p) out[h] = s * 64 + Math.min(p, 63);
      }
    }));
    return out;
  }

  /** Rest factor of hinge h of sheet i at the start of step s. */
  private factor(s: number, i: number, h: number): number {
    const last = this.lastAt[Math.min(s, this.lastAt.length - 1)][i][h];
    if (last < 0) return this.rest[0];
    const age = s - 1 - last;
    return this.rest[Math.min(2, Math.max(0, age))];
  }

  /** Sets every hinge target for time `t` (0..1) through phase `p` of step `s`. */
  setTargets(s: number, p: number, t: number) {
    const A = this.angles[s]?.[p];
    const np = this.angles[s]?.length || 1;
    const tc = Math.min(1, Math.max(0, t));
    // Progress through the whole step, for easing older folds flatter.
    const ts = easeInOut((p + tc) / np);
    this.solvers.forEach((sv, i) => {
      const T = sv.target;
      if (!A) { T.fill(0); return; }
      const a = A.a[i], b = A.b[i];
      const fa = (h: number) => { const f0 = this.factor(s, i, h), f1 = this.factor(s + 1, i, h); return f0 + (f1 - f0) * ts; };
      if (A.kind === 'crease') {
        const m = A.mid![i], w = 0.5 - 0.5 * Math.cos(2 * Math.PI * tc); // fold and unfold, at rest at both ends
        for (let h = 0; h < T.length; h++) T[h] = fa(h) * (a[h] + (m[h] - a[h]) * 0.9 * w);
      } else {
        const e = easeInOut(tc);
        const xa = A.exA?.[i], xb = A.exB?.[i];
        for (let h = 0; h < T.length; h++) {
          if ((xa && xa[h]) || (xb && xb[h])) {
            // Shaped creases sit at their exact 3D angle, however flat the other folds are pressed.
            const f = fa(h), va = xa && xa[h] ? a[h] : f * a[h], vb = xb && xb[h] ? b[h] : f * b[h];
            T[h] = va + (vb - va) * e;
          } else T[h] = fa(h) * (a[h] + (b[h] - a[h]) * e);
        }
      }
    });
  }

  /** Sets targets for the finished state of step `s` (its last phase at t = 1), or flat paper. */
  setRestTargets(s: number) {
    if (s <= 0) { this.solvers.forEach((sv) => sv.target.fill(0)); return; }
    for (let k = s - 1; k >= 0; k--) {
      const ph = this.angles[k];
      if (ph.length) { this.setTargets(k, ph.length - 1, 1); return; }
    }
    this.solvers.forEach((sv) => sv.target.fill(0));
  }

  /** Changes how far folds rest open ([newest, previous, older] factors of a full fold) and drops cached states. */
  setRest(rest: [number, number, number]) {
    this.rest = rest;
    this.cache.length = 1;
    this.frames = [];
  }

  /**
   * Recorded positions through each step (time 0..1 across the whole step), filled as the step is
   * simulated. Playing and scrubbing replay these instead of running the solver live, so the paper
   * moves the same way every time and never lags or wobbles.
   */
  frames: ({ t: number; x: Float64Array[] }[] | undefined)[] = [];

  /** Makes sure step `s` has been simulated (so its frames exist). */
  ensureStep(s: number, quality = 1) {
    if (s >= this.model.steps.length || this.frames[s]) return;
    this.stateAt(s + 1, quality);
  }

  /** Loads the paper's position at time t of step s, blended between the two nearest frames. */
  loadFrame(s: number, t: number): boolean {
    const F = this.frames[s];
    if (!F || !F.length) return false;
    let j = 0;
    while (j < F.length - 1 && F[j + 1].t <= t) j++;
    const a = F[j], b = F[Math.min(F.length - 1, j + 1)];
    const w = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
    this.solvers.forEach((sv, i) => {
      const xa = a.x[i], xb = b.x[i], X = sv.x;
      for (let k = 0; k < X.length; k++) X[k] = xa[k] + (xb[k] - xa[k]) * w;
      sv.v.fill(0);
    });
    return true;
  }

  iterate(iters: number): number {
    let mx = 0;
    for (const s of this.solvers) mx = Math.max(mx, s.step(iters));
    return mx;
  }

  load(state: { x: Float64Array; theta: Float64Array }[]) {
    this.solvers.forEach((s, i) => s.setState(state[i]));
  }

  /** Solver state at the start of step `s` (s = steps for the finished model), computing it if needed. */
  stateAt(s: number, quality = 1): { x: Float64Array; theta: Float64Array }[] {
    let k = s;
    while (k > 0 && !this.cache[k]) k--;
    this.load(this.cache[k]!);
    for (; k < s; k++) {
      this.runStep(k, quality);
      this.cache[k + 1] = this.solvers.map((sv) => sv.getState());
    }
    return this.cache[s]!;
  }

  /** Simulates step `s` from the current state to its end, ramping the targets as the animation does. */
  runStep(s: number, quality = 1) {
    const ph = this.angles[s];
    const np = Math.max(1, ph.length);
    const sub = Math.max(8, Math.round(20 * quality));
    const snap = () => this.solvers.map((sv) => sv.x.slice());
    const frames: { t: number; x: Float64Array[] }[] = [{ t: 0, x: snap() }];
    for (let p = 0; p < ph.length; p++) {
      const changed = this.solvers.some((_, i) => ph[p].kind === 'crease' || ph[p].a[i].some((v, h) => v !== ph[p].b[i][h]));
      if (!changed) continue;
      for (let k = 1; k <= sub; k++) {
        this.setTargets(s, p, k / sub);
        // Let the paper catch up with its targets before recording, so frames follow the motion closely.
        let it = 0, speed = this.iterate(Math.round(40 * quality));
        while (speed > 2e-3 && it < 400 * quality) { speed = this.iterate(20); it += 20; }
        frames.push({ t: (p + k / sub) / np, x: snap() });
      }
    }
    this.setRestTargets(s + 1);
    this.settle(quality);
    // The last frame is the settled paper, so the end of the step matches the start of the next.
    if (frames.length > 1 && frames[frames.length - 1].t >= 1 - 1e-9) frames.pop();
    frames.push({ t: 1, x: snap() });
    this.frames[s] = frames;
  }

  /** Iterates until the paper stops moving (or a budget runs out). */
  settle(quality = 1) {
    const max = Math.round(3000 * quality);
    for (const s of this.solvers) s.drag = 0.985;
    let i = 0;
    for (; i < max; i += 50) if (this.iterate(50) < 1e-3) break;
    for (const s of this.solvers) s.drag = 0.9995;
    this.lastSettle = i;
  }
}

// ---------------------------------------------------------------------------
// Rigid alignment (Horn's quaternion method): rotation R and translation t that
// best map points `src` onto `dst` (both 3 per point) with weights `w`.

export function alignRigid(src: ArrayLike<number>, dst: ArrayLike<number>, w: ArrayLike<number>): { R: number[]; t: number[] } {
  const n = w.length;
  let W = 0;
  const cs = [0, 0, 0], cd = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const wi = w[i];
    W += wi;
    for (let k = 0; k < 3; k++) { cs[k] += wi * src[3 * i + k]; cd[k] += wi * dst[3 * i + k]; }
  }
  if (W <= 0) return { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  for (let k = 0; k < 3; k++) { cs[k] /= W; cd[k] /= W; }
  // Cross-covariance S[a][b] = sum w (s_a)(d_b)
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const wi = w[i];
    const sx = src[3 * i] - cs[0], sy = src[3 * i + 1] - cs[1], sz = src[3 * i + 2] - cs[2];
    const dx = dst[3 * i] - cd[0], dy = dst[3 * i + 1] - cd[1], dz = dst[3 * i + 2] - cd[2];
    S[0] += wi * sx * dx; S[1] += wi * sx * dy; S[2] += wi * sx * dz;
    S[3] += wi * sy * dx; S[4] += wi * sy * dy; S[5] += wi * sy * dz;
    S[6] += wi * sz * dx; S[7] += wi * sz * dy; S[8] += wi * sz * dz;
  }
  const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = S;
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  const q = topEigenvector4(N);
  const [qw, qx, qy, qz] = q;
  const R = [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
    2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
    2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
  ];
  const t = [
    cd[0] - (R[0] * cs[0] + R[1] * cs[1] + R[2] * cs[2]),
    cd[1] - (R[3] * cs[0] + R[4] * cs[1] + R[5] * cs[2]),
    cd[2] - (R[6] * cs[0] + R[7] * cs[1] + R[8] * cs[2]),
  ];
  return { R, t };
}

/** Eigenvector of the largest eigenvalue of a symmetric 4x4 matrix (Jacobi rotations). */
function topEigenvector4(A0: number[][]): number[] {
  const A = A0.map((r) => r.slice());
  const V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += A[p][q] * A[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
      if (Math.abs(A[p][q]) < 1e-30) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 4; k++) {
        const akp = A[k][p], akq = A[k][q];
        A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 4; k++) {
        const apk = A[p][k], aqk = A[q][k];
        A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 4; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (A[i][i] > A[best][best]) best = i;
  return [V[0][best], V[1][best], V[2][best], V[3][best]];
}
