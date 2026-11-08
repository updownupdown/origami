// 2D geometry for flat-folded paper.
// Paper lives in "paper space" (the unfolded sheet, in cm). Each face of the
// folded model carries a 2D isometry that maps paper space to world space.

export type V2 = [number, number];

/** Isometry x' = a*x + c*y + e, y' = b*x + d*y + f (an SVG-style matrix). */
export type Mat = [number, number, number, number, number, number];

export const EPS = 1e-6;

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export const add = (p: V2, q: V2): V2 => [p[0] + q[0], p[1] + q[1]];
export const sub = (p: V2, q: V2): V2 => [p[0] - q[0], p[1] - q[1]];
export const mul = (p: V2, k: number): V2 => [p[0] * k, p[1] * k];
export const dot = (p: V2, q: V2) => p[0] * q[0] + p[1] * q[1];
export const cross = (p: V2, q: V2) => p[0] * q[1] - p[1] * q[0];
export const len = (p: V2) => Math.hypot(p[0], p[1]);
export const dist = (p: V2, q: V2) => len(sub(p, q));
export const norm = (p: V2): V2 => {
  const l = len(p);
  if (l < EPS) throw new Error('Zero-length vector');
  return [p[0] / l, p[1] / l];
};
export const perp = (p: V2): V2 => [-p[1], p[0]];
export const lerp = (p: V2, q: V2, t: number): V2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
export const near = (p: V2, q: V2, tol = 1e-4) => dist(p, q) < tol;

export function apply(m: Mat, p: V2): V2 {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** Returns a∘b (apply b first, then a). */
export function compose(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export const det = (m: Mat) => m[0] * m[3] - m[1] * m[2];

/** Reflection across the line through p and q. */
export function reflection(p: V2, q: V2): Mat {
  const [ux, uy] = norm(sub(q, p));
  const a = ux * ux - uy * uy;
  const b = 2 * ux * uy;
  // Linear part [[a, b], [b, -a]]; translation keeps p fixed.
  return [a, b, b, -a, p[0] - (a * p[0] + b * p[1]), p[1] - (b * p[0] - a * p[1])];
}

export function rotation(center: V2, degrees: number): Mat {
  const t = (degrees * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return [c, s, -s, c, center[0] - (c * center[0] - s * center[1]), center[1] - (s * center[0] + c * center[1])];
}

export function translation(v: V2): Mat {
  return [1, 0, 0, 1, v[0], v[1]];
}

export function reflectPoint(x: V2, p: V2, q: V2): V2 {
  return apply(reflection(p, q), x);
}

/** Signed side of x relative to the directed line p→q (positive = left). */
export function side(x: V2, p: V2, q: V2): number {
  return cross(sub(q, p), sub(x, p)) / len(sub(q, p));
}

export function signedArea(poly: V2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function centroid(poly: V2[]): V2 {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const w = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * w;
    cy += (p[1] + q[1]) * w;
    a += w;
  }
  if (Math.abs(a) < EPS) {
    const s = poly.reduce((acc, p) => add(acc, p), [0, 0] as V2);
    return mul(s, 1 / poly.length);
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/**
 * Splits a convex polygon by the line p→q.
 * Returns [left, right]; either may be null when the line misses the polygon.
 */
export function splitPolygon(poly: V2[], p: V2, q: V2, tol = 1e-7): [V2[] | null, V2[] | null] {
  const d = poly.map((x) => side(x, p, q));
  const left: V2[] = [];
  const right: V2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = d[i], db = d[(i + 1) % poly.length];
    if (da >= -tol) left.push(a);
    if (da <= tol) right.push(a);
    if ((da > tol && db < -tol) || (da < -tol && db > tol)) {
      const t = da / (da - db);
      const x = lerp(a, b, t);
      left.push(x);
      right.push(x);
    }
  }
  const clean = (pts: V2[]) => {
    const out: V2[] = [];
    for (const x of pts) if (!out.length || !near(out[out.length - 1], x, 1e-9)) out.push(x);
    if (out.length > 1 && near(out[0], out[out.length - 1], 1e-9)) out.pop();
    return out.length >= 3 && Math.abs(signedArea(out)) > 1e-8 ? out : null;
  };
  return [clean(left), clean(right)];
}

/** Point in (convex or simple) polygon, inclusive of the boundary within tol. */
export function containsPoint(poly: V2[], x: V2, tol = 1e-5): boolean {
  for (let i = 0; i < poly.length; i++) {
    if (distToSegment(x, poly[i], poly[(i + 1) % poly.length]) <= tol) return true;
  }
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > x[1] !== yj > x[1] && x[0] < ((xj - xi) * (x[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(x: V2, a: V2, b: V2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-18) return dist(x, a);
  const t = Math.max(0, Math.min(1, dot(sub(x, a), ab) / l2));
  return dist(x, add(a, mul(ab, t)));
}

export function lineIntersection(p1: V2, p2: V2, p3: V2, p4: V2): V2 | null {
  const d1 = sub(p2, p1), d2 = sub(p4, p3);
  const den = cross(d1, d2);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(p3, p1), d2) / den;
  return add(p1, mul(d1, t));
}

/** Two segments overlap along a shared line with positive length. */
export function segmentsOverlap(a1: V2, a2: V2, b1: V2, b2: V2, tol = 1e-5): boolean {
  if (distToLine(b1, a1, a2) > tol || distToLine(b2, a1, a2) > tol) return false;
  const u = norm(sub(a2, a1));
  const ta1 = 0, ta2 = dot(sub(a2, a1), u);
  const tb1 = dot(sub(b1, a1), u), tb2 = dot(sub(b2, a1), u);
  const lo = Math.max(Math.min(ta1, ta2), Math.min(tb1, tb2));
  const hi = Math.min(Math.max(ta1, ta2), Math.max(tb1, tb2));
  return hi - lo > tol;
}

export function distToLine(x: V2, p: V2, q: V2): number {
  return Math.abs(side(x, p, q));
}

export function bbox(points: V2[]): { min: V2; max: V2 } {
  const min: V2 = [Infinity, Infinity], max: V2 = [-Infinity, -Infinity];
  for (const p of points) {
    min[0] = Math.min(min[0], p[0]);
    min[1] = Math.min(min[1], p[1]);
    max[0] = Math.max(max[0], p[0]);
    max[1] = Math.max(max[1], p[1]);
  }
  return { min, max };
}

/** Parameter range [t0, t1] of the line p + t*(q-p)/|q-p| inside a convex polygon. */
export function clipLineToPolygon(poly: V2[], p: V2, q: V2): [number, number] | null {
  const u = norm(sub(q, p));
  const ts: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = side(a, p, q), db = side(b, p, q);
    if (Math.abs(da) < 1e-6) ts.push(dot(sub(a, p), u));
    if ((da > 1e-6 && db < -1e-6) || (da < -1e-6 && db > 1e-6)) {
      const x = lerp(a, b, da / (da - db));
      ts.push(dot(sub(x, p), u));
    }
  }
  if (ts.length < 2) return null;
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  return t1 - t0 > 1e-6 ? [t0, t1] : null;
}
