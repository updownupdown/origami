// Layer order for a crease pattern folded flat all at once (a collapse).
//
// Every face has its folded position (a paper-to-paper map). Faces that overlap after folding need an
// order. The order must keep paper from passing through paper, which comes down to three local rules
// (as in Jason Ku's Flat-Folder):
//   - a crease puts its two faces in the order its mountain/valley says;
//   - taco-taco: two creases folded along the same line, on the same side, nest or stay apart (never
//     interleave);
//   - taco-tortilla: a face lying across a fold line can't sit between the two faces of that fold;
//   - three faces that overlap in one place can't be ordered in a cycle.
// A small backtracking search with propagation finds an order, and a topological sort turns it
// into layer numbers.

import { apply, type Mat, type V2 } from './geometry.ts';

export interface LayerFace {
  /** The face in paper coordinates (convex). */
  poly: V2[];
  /** Paper to folded paper. */
  T: Mat;
}
export interface LayerCrease {
  /** The two faces it joins. */
  f: number;
  g: number;
  /** The crease in paper coordinates. */
  a: V2;
  b: V2;
  /** +1: g ends up above f; -1: below; 0: either (let the solver choose). */
  above: number;
}

const EPS = 1e-6;

function clip(subject: V2[], clipPoly: V2[]): V2[] {
  // Sutherland–Hodgman; both convex. Works for either winding of clipPoly.
  const ccw = area(clipPoly) > 0 ? 1 : -1;
  let out = subject;
  for (let i = 0; i < clipPoly.length && out.length; i++) {
    const a = clipPoly[i], b = clipPoly[(i + 1) % clipPoly.length];
    const inside = (p: V2) => ccw * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) > -1e-9;
    const inp = out;
    out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j], q = inp[(j + 1) % inp.length];
      const pi = inside(p), qi = inside(q);
      if (pi) out.push(p);
      if (pi !== qi) {
        const d1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        const d2 = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
        const t = d1 / (d1 - d2);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}
function area(P: V2[]): number {
  let s = 0;
  for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}
function centroidOf(P: V2[]): V2 {
  let x = 0, y = 0;
  for (const p of P) { x += p[0]; y += p[1]; }
  return [x / P.length, y / P.length];
}

/**
 * Returns a layer number per face (0 = bottom) and the side each crease went, or null if no order
 * keeps the paper apart. `up` is +1 when the folded paper's front faces up in the world.
 */
export function solveLayers(faces: LayerFace[], creases: LayerCrease[], scale: number): { layer: number[] } | null {
  const n = faces.length;
  const P = faces.map((f) => f.poly.map((p) => apply(f.T, p)));
  const minArea = scale * scale * 1e-6;
  // Overlapping pairs and their shared regions.
  const key = (i: number, j: number) => (i < j ? i * n + j : j * n + i);
  const shared = new Map<number, V2[]>();
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const r = clip(P[i], P[j]);
    if (r.length >= 3 && Math.abs(area(r)) > minArea) shared.set(key(i, j), r);
  }
  // Variable per overlapping pair (i<j): +1 i above j, -1 below, 0 unknown.
  const val = new Map<number, number>();
  for (const k of shared.keys()) val.set(k, 0);
  const get = (i: number, j: number) => { const v = val.get(key(i, j)) ?? 0; return i < j ? v : -v; };
  type Clause = { lits: [number, number, number][] }; // OR of (i, j, sign): "i above j" if sign=+1
  const clauses: Clause[] = [];
  const unit: [number, number, number][] = [];
  // Creases: the order their kind asks for.
  const foldLines: { c: LayerCrease; p: V2; q: V2; side: number }[] = [];
  for (const c of creases) {
    if (!shared.has(key(c.f, c.g))) continue;
    if (c.above) unit.push([c.g, c.f, c.above]);
    const p = apply(faces[c.f].T, c.a), q = apply(faces[c.f].T, c.b);
    // Which side of the fold line the two faces lie on.
    const cf = centroidOf(P[c.f]);
    const s = (q[0] - p[0]) * (cf[1] - p[1]) - (q[1] - p[1]) * (cf[0] - p[0]) > 0 ? 1 : -1;
    foldLines.push({ c, p, q, side: s });
  }
  const colinear = (p: V2, q: V2, r: V2, s: V2) => {
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const d = (x: V2) => Math.abs((q[0] - p[0]) * (x[1] - p[1]) - (q[1] - p[1]) * (x[0] - p[0])) / L;
    if (d(r) > scale * 1e-5 || d(s) > scale * 1e-5) return false;
    const u: V2 = [(q[0] - p[0]) / L, (q[1] - p[1]) / L];
    const t = (x: V2) => (x[0] - p[0]) * u[0] + (x[1] - p[1]) * u[1];
    const a0 = 0, a1 = L, b0 = Math.min(t(r), t(s)), b1 = Math.max(t(r), t(s));
    return Math.min(a1, b1) - Math.max(a0, b0) > scale * 1e-4;
  };
  // Taco-taco: same line, same side: a<b and c<d (the two faces of each) must not interleave.
  for (let x = 0; x < foldLines.length; x++) for (let y = x + 1; y < foldLines.length; y++) {
    const A = foldLines[x], B = foldLines[y];
    if (!colinear(A.p, A.q, B.p, B.q)) continue;
    const [a, b] = [A.c.f, A.c.g], [c, d] = [B.c.f, B.c.g];
    if (new Set([a, b, c, d]).size < 4) continue;
    if (!shared.has(key(a, c)) || !shared.has(key(a, d)) || !shared.has(key(b, c)) || !shared.has(key(b, d))) continue;
    // Forbid every interleaving: for faces of A (a,b) and B (c,d), not (one of B between a and b while the other isn't).
    // Encode: (c between a,b) == (d between a,b). Using pair orders: c between a,b  <=>  ord(a,c) != ord(b,c).
    // So ord(a,c) xor ord(b,c) == ord(a,d) xor ord(b,d): written as 8 clauses over 4 literals.
    const L4: [number, number][] = [[a, c], [b, c], [a, d], [b, d]];
    for (let m = 0; m < 16; m++) {
      const bits = [0, 1, 2, 3].map((k) => (m >> k) & 1);
      if ((bits[0] ^ bits[1]) === (bits[2] ^ bits[3])) continue;
      // Forbid this combination.
      clauses.push({ lits: L4.map(([i, j], k) => [i, j, bits[k] ? -1 : 1]) as [number, number, number][] });
    }
  }
  // Taco-tortilla: a face k crossing fold line (a,b) can't sit between a and b: ord(a,k) == ord(b,k).
  for (const F of foldLines) {
    const [a, b] = [F.c.f, F.c.g];
    for (let k = 0; k < n; k++) {
      if (k === a || k === b || !shared.has(key(a, k)) || !shared.has(key(b, k))) continue;
      // Does k's folded polygon contain part of the fold line in its interior?
      const Pk = P[k];
      const mid: V2 = [(F.p[0] + F.q[0]) / 2, (F.p[1] + F.q[1]) / 2];
      const pts = [0.2, 0.5, 0.8].map((t): V2 => [F.p[0] + (F.q[0] - F.p[0]) * t, F.p[1] + (F.q[1] - F.p[1]) * t]);
      const inside = (x: V2) => {
        const s = area(Pk) > 0 ? 1 : -1;
        for (let i = 0; i < Pk.length; i++) {
          const u = Pk[i], v = Pk[(i + 1) % Pk.length];
          if (s * ((v[0] - u[0]) * (x[1] - u[1]) - (v[1] - u[1]) * (x[0] - u[0])) < scale * 1e-4 * Math.hypot(v[0] - u[0], v[1] - u[1])) return false;
        }
        return true;
      };
      if (!pts.some(inside) && !inside(mid)) continue;
      clauses.push({ lits: [[a, k, 1], [b, k, -1]] }); // not (a below k and b above k)
      clauses.push({ lits: [[a, k, -1], [b, k, 1]] });
    }
  }
  // Transitivity on triples sharing a region.
  const nb: number[][] = Array.from({ length: n }, () => []);
  for (const k of shared.keys()) { const i = Math.floor(k / n), j = k % n; nb[i].push(j); nb[j].push(i); }
  for (let i = 0; i < n; i++) for (const j of nb[i]) {
    if (j <= i) continue;
    for (const k of nb[j]) {
      if (k <= j || !shared.has(key(i, k))) continue;
      const r = clip(shared.get(key(i, j))!, P[k]);
      if (r.length < 3 || Math.abs(area(r)) < minArea) continue;
      // No cycle i>j>k>i nor i<j<k<i.
      clauses.push({ lits: [[i, j, -1], [j, k, -1], [k, i, -1]] });
      clauses.push({ lits: [[i, j, 1], [j, k, 1], [k, i, 1]] });
    }
  }
  // Solve: unit propagation + backtracking.
  const byVar = new Map<number, number[]>();
  clauses.forEach((c, ci) => { for (const [i, j] of c.lits) { const k = key(i, j); (byVar.get(k) ?? byVar.set(k, []).get(k)!).push(ci); } });
  const trail: number[] = [];
  const assign = (i: number, j: number, s: number): boolean => {
    const k = key(i, j), v = i < j ? s : -s;
    const cur = val.get(k);
    if (cur === undefined) return true;
    if (cur) return cur === v;
    val.set(k, v);
    trail.push(k);
    return true;
  };
  const propagate = (start: number): boolean => {
    for (let q = start; q < trail.length; q++) {
      for (const ci of byVar.get(trail[q]) ?? []) {
        let free: [number, number, number] | null = null, nFree = 0, sat = false;
        for (const l of clauses[ci].lits) {
          const v = get(l[0], l[1]);
          if (v === 0) { nFree++; free = l; } else if (v === l[2]) { sat = true; break; }
        }
        if (sat) continue;
        if (nFree === 0) return false;
        if (nFree === 1 && !assign(free![0], free![1], free![2])) return false;
      }
    }
    return true;
  };
  for (const [i, j, s] of unit) if (!assign(i, j, s)) return null;
  if (!propagate(0)) return null;
  const vars = [...val.keys()];
  let budget = 200000;
  const search = (): boolean => {
    if (--budget < 0) return false;
    const k = vars.find((x) => val.get(x) === 0);
    if (k === undefined) return true;
    for (const s of [1, -1]) {
      const mark = trail.length;
      val.set(k, s); trail.push(k);
      if (propagate(mark) && search()) return true;
      while (trail.length > mark) val.set(trail.pop()!, 0);
    }
    return false;
  };
  if (!search()) return null;
  // Layers: topological order of "above".
  const indeg = new Array(n).fill(0), out: number[][] = Array.from({ length: n }, () => []);
  for (const [k, v] of val) {
    const i = Math.floor(k / n), j = k % n;
    const [lo, hi] = v > 0 ? [j, i] : [i, j];
    out[lo].push(hi); indeg[hi]++;
  }
  const layer = new Array(n).fill(0);
  const queue = [...Array(n).keys()].filter((i) => !indeg[i]);
  let seen = 0;
  while (queue.length) {
    const i = queue.shift()!;
    seen++;
    for (const j of out[i]) { layer[j] = Math.max(layer[j], layer[i] + 1); if (--indeg[j] === 0) queue.push(j); }
  }
  if (seen < n) return null;
  return { layer };
}

