// Compiles an authored fold script into per-step geometry the viewer can animate.
//
// Model: every face of the folded paper is a convex polygon in paper space plus a
// 2D isometry (paper -> world) and an integer layer. Flat folds reflect faces across
// a line; layers are re-ranked after each operation. This is exact for flat-folded
// states; the motion between states is an approximation (see docs/fidelity.md).

import {
  type Mat, type V2, IDENTITY, add, apply, bbox, centroid, clipLineToPolygon, compose, containsPoint,
  cross, det, dist, distToLine, dot, invert, len, lerp, lineIntersection, mul, near, norm, perp,
  reflection, rotation, segmentsOverlap, side, signedArea, splitPolygon, sub, translation,
} from './geometry.ts';
import type {
  CameraPreset, CameraSpec, CompiledModel, CompiledStep, DiagramArrow, DiagramLine, Face, FoldOp,
  LayerChoice, LineSpec, ModelScript, Op, Phase, PhaseFace, PointExpr, SheetInfo, StepSpec,
} from './types.ts';

export class CompileError extends Error {
  step: number;
  constructor(step: number, message: string) {
    super(step >= 0 ? `Step ${step + 1}: ${message}` : message);
    this.step = step;
  }
}

interface Sheet extends SheetInfo {
  names: Map<string, V2>; // paper coordinates
  m0: Mat; // initial paper -> world
}

interface State {
  faces: Face[];
  /** Named fixed points in world space (they do not move with the paper). */
  pins: Map<string, V2>;
  sheets: Map<string, Sheet>;
  active: string;
  nextId: number;
}

const DEFAULT_FRONT = '#e8642c';
const DEFAULT_BACK = '#fbf7ee';

export type BaseLibrary = Record<string, ModelScript>;

// ---------------------------------------------------------------------------
// Point expressions

type Tok = { t: 'id' | 'num' | 'p'; v: string };

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:([A-Za-z_][\w.]*)|(-?\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)|([(),]))/y;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m || m[0].length === 0) {
      if (/^\s*$/.test(s.slice(i))) break;
      throw new Error(`Cannot read point expression "${s}"`);
    }
    if (m[1]) out.push({ t: 'id', v: m[1] });
    else if (m[2]) out.push({ t: 'num', v: m[2] });
    else if (m[3]) out.push({ t: 'p', v: m[3] });
    i = re.lastIndex;
  }
  return out;
}

type Ast = { k: 'num'; v: number } | { k: 'name'; v: string } | { k: 'call'; f: string; args: Ast[] };

function parseExpr(s: string): Ast {
  const toks = tokenize(s);
  let i = 0;
  const parse = (): Ast => {
    const tok = toks[i++];
    if (!tok) throw new Error(`Unexpected end of "${s}"`);
    if (tok.t === 'num') {
      const [a, b] = tok.v.split('/');
      return { k: 'num', v: b ? Number(a) / Number(b) : Number(a) };
    }
    if (tok.t === 'id') {
      if (toks[i]?.v === '(') {
        i++;
        const args: Ast[] = [];
        while (toks[i]?.v !== ')') {
          args.push(parse());
          if (toks[i]?.v === ',') i++;
          else if (!toks[i]) throw new Error(`Missing ) in "${s}"`);
        }
        i++;
        return { k: 'call', f: tok.v, args };
      }
      return { k: 'name', v: tok.v };
    }
    throw new Error(`Unexpected "${tok.v}" in "${s}"`);
  };
  const ast = parse();
  if (i !== toks.length) throw new Error(`Unexpected text after expression in "${s}"`);
  return ast;
}

// ---------------------------------------------------------------------------
// Sheet / face helpers

const worldPoly = (f: Face) => f.poly.map((p) => apply(f.m, p));

function sheetFaces(st: State, sheet: string) {
  return st.faces.filter((f) => f.sheet === sheet);
}

function paperToWorld(st: State, sheet: string, p: V2): V2 {
  let best: Face | null = null;
  for (const f of sheetFaces(st, sheet)) {
    if (containsPoint(f.poly, p, 1e-4) && (!best || f.layer > best.layer)) best = f;
  }
  if (!best) throw new Error(`Point (${p[0].toFixed(2)}, ${p[1].toFixed(2)}) is not on sheet "${sheet}"`);
  return apply(best.m, p);
}

function worldToPaper(st: State, sheet: string | null, w: V2): { sheet: string; p: V2 } {
  let best: Face | null = null;
  for (const f of st.faces) {
    if (sheet && f.sheet !== sheet) continue;
    if (containsPoint(worldPoly(f), w, 1e-4) && (!best || f.layer > best.layer)) best = f;
  }
  if (!best) throw new Error(`No paper at (${w[0].toFixed(2)}, ${w[1].toFixed(2)})`);
  return { sheet: best.sheet, p: apply(invert(best.m), w) };
}

function lookupName(st: State, name: string): { sheet: string; p: V2 } {
  if (name.includes('.')) {
    const [s, n] = name.split('.', 2);
    const sh = st.sheets.get(s);
    const p = sh?.names.get(n);
    if (!sh || !p) throw new Error(`Unknown point "${name}"`);
    return { sheet: s, p };
  }
  const act = st.sheets.get(st.active)!;
  const p = act.names.get(name);
  if (p) return { sheet: act.id, p };
  for (const sh of st.sheets.values()) {
    const q = sh.names.get(name);
    if (q) return { sheet: sh.id, p: q };
  }
  throw new Error(`Unknown point "${name}"`);
}

function evalAst(st: State, a: Ast): V2 | number {
  if (a.k === 'num') return a.v;
  if (a.k === 'name') {
    const pin = st.pins.get(a.v);
    if (pin) return pin;
    const { sheet, p } = lookupName(st, a.v);
    return paperToWorld(st, sheet, p);
  }
  const args = a.args.map((x) => evalAst(st, x));
  const pt = (i: number): V2 => {
    const v = args[i];
    if (!Array.isArray(v)) throw new Error(`${a.f}() argument ${i + 1} must be a point`);
    return v;
  };
  const num = (i: number): number => {
    const v = args[i];
    if (typeof v !== 'number') throw new Error(`${a.f}() argument ${i + 1} must be a number`);
    return v;
  };
  switch (a.f) {
    case 'mid':
      return lerp(pt(0), pt(1), 0.5);
    case 'lerp':
      return lerp(pt(0), pt(1), num(2));
    case 'intersect': {
      const x = lineIntersection(pt(0), pt(1), pt(2), pt(3));
      if (!x) throw new Error('intersect(): lines are parallel');
      return x;
    }
    case 'reflect':
      return apply(reflection(pt(1), pt(2)), pt(0));
    case 'project': {
      const p = pt(1), u = norm(sub(pt(2), p));
      return add(p, mul(u, dot(sub(pt(0), p), u)));
    }
    case 'shift': {
      // shift(X, A, B, d): X moved distance d to the left of the direction A -> B.
      const a = pt(1), b = pt(2), n = perp(norm(sub(b, a)));
      return add(pt(0), mul(n, num(3)));
    }
    case 'at': {
      // at(x, y): a fixed point in world space, measured from the active sheet's starting lower-left corner.
      const sh = st.sheets.get(st.active)!;
      const origin = bbox(cornerWorld0(sh)).min;
      return [origin[0] + num(0), origin[1] + num(1)];
    }
    case 'paper': {
      // paper(x, y) or paper(sheet, x, y): a literal point in the sheet's starting view.
      return literal(st, st.active, [num(0), num(1)]);
    }
    default:
      throw new Error(`Unknown function ${a.f}()`);
  }
}

/** A literal [x, y] means "the point of the sheet that was at (x, y) in its starting view". */
function literal(st: State, sheet: string, xy: V2): V2 {
  const sh = st.sheets.get(sheet)!;
  const w0 = apply(sh.m0, [0, 0]);
  // Starting view origin is the sheet's lower-left corner in world space.
  const origin: V2 = bbox(cornerWorld0(sh)).min;
  const p = apply(invert(sh.m0), add(origin, xy));
  void w0;
  return paperToWorld(st, sheet, p);
}

function cornerWorld0(sh: Sheet): V2[] {
  return ([[0, 0], [sh.w, 0], [sh.w, sh.h], [0, sh.h]] as V2[]).map((p) => apply(sh.m0, p));
}

function resolvePoint(st: State, e: PointExpr): V2 {
  if (Array.isArray(e)) {
    if (e.length !== 2 || typeof e[0] !== 'number') throw new Error(`Bad point ${JSON.stringify(e)}`);
    return literal(st, st.active, e as V2);
  }
  if (typeof e === 'number') throw new Error(`A point is needed, got the number ${e}`);
  const v = evalAst(st, parseExpr(String(e)));
  if (!Array.isArray(v)) throw new Error(`"${e}" is a number, not a point`);
  return v;
}

// ---------------------------------------------------------------------------
// Fold lines (Huzita–Hatori axioms)

/**
 * YAML splits `[lerp(O, B, 0.5), C]` at every comma. Re-join the pieces at
 * bracket depth 0 so authors can write point expressions naturally.
 */
export function fixList<T>(v: T): T {
  if (!Array.isArray(v) || v.length <= 2 || v.some((x) => typeof x !== 'string')) return v;
  const joined = (v as string[]).join(',');
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of joined) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out as unknown as T;
}

function resolveLine(st: State, spec0: LineSpec | [PointExpr, PointExpr]): [V2, V2] {
  const spec = (Array.isArray(spec0) ? fixList(spec0) : Object.fromEntries(Object.entries(spec0).map(([k, v]) => [k, fixList(v)]))) as LineSpec | [PointExpr, PointExpr];
  if (Array.isArray(spec)) return checkLine(resolvePoint(st, spec[0]), resolvePoint(st, spec[1]));
  const P = (e: PointExpr) => resolvePoint(st, e);
  const pick = spec.pick ?? 0;
  // Axiom 1: through two points.
  if (Array.isArray(spec.through) && spec.through.length === 2 && !isNumPair(spec.through)) {
    return checkLine(P(spec.through[0] as PointExpr), P(spec.through[1] as PointExpr));
  }
  // Axiom 4: through a point, perpendicular to a line.
  if (spec.through !== undefined && spec.perpendicular) {
    const x = P(spec.through as PointExpr);
    const a = P(spec.perpendicular[0]), b = P(spec.perpendicular[1]);
    return checkLine(x, add(x, perp(norm(sub(b, a)))));
  }
  // Axiom 2: bring point onto point.
  if (spec.bring !== undefined && spec.to !== undefined && !isLinePair(spec.bring)) {
    return bisector(P(spec.bring as PointExpr), P(spec.to));
  }
  // Axiom 3: bring line onto line.
  if (isLinePair(spec.bring) && spec.onto) {
    const [p1, p2] = (spec.bring as [PointExpr, PointExpr]).map(P);
    const [q1, q2] = spec.onto.map(P);
    const u1 = norm(sub(p2, p1)), u2 = norm(sub(q2, q1));
    const x = lineIntersection(p1, p2, q1, q2);
    if (!x) {
      // Parallel: the mid-line.
      const m = lerp(p1, apply(reflection(q1, q2), p1), 0.5);
      return checkLine(m, add(m, u1));
    }
    const d = pick === 0 ? add(u1, u2) : sub(u1, u2);
    return checkLine(x, add(x, len(d) < 1e-9 ? perp(u1) : norm(d)));
  }
  // Axiom 5: bring a point onto a line, folding through another point.
  if (spec.bring !== undefined && spec.onto && spec.through !== undefined) {
    const p = P(spec.bring as PointExpr), s = P(spec.through as PointExpr);
    const [a, b] = spec.onto.map(P);
    const r = dist(p, s);
    const u = norm(sub(b, a));
    const foot = add(a, mul(u, dot(sub(s, a), u)));
    const h = dist(s, foot);
    if (h > r + 1e-9) throw new Error('Axiom 5 has no solution: the point cannot reach the line');
    const k = Math.sqrt(Math.max(0, r * r - h * h));
    const sols = [add(foot, mul(u, -k)), add(foot, mul(u, k))];
    return bisector(p, sols[pick] ?? sols[0]);
  }
  // Axiom 7: bring a point onto a line, perpendicular to another line.
  if (spec.bring !== undefined && spec.onto && spec.perpendicular) {
    const p = P(spec.bring as PointExpr);
    const [a, b] = spec.onto.map(P);
    const [c, d] = spec.perpendicular.map(P);
    const dir = norm(sub(d, c));
    const x = lineIntersection(p, add(p, dir), a, b);
    if (!x) throw new Error('Axiom 7 has no solution');
    return bisector(p, x);
  }
  throw new Error('Could not understand the fold line');
}

const isNumPair = (v: unknown) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'number';
const isLinePair = (v: unknown) => Array.isArray(v) && v.length === 2 && !isNumPair(v);

function bisector(p: V2, q: V2): [V2, V2] {
  if (near(p, q, 1e-9)) throw new Error('Cannot fold a point onto itself');
  const m = lerp(p, q, 0.5);
  return [m, add(m, perp(norm(sub(q, p))))];
}

function checkLine(p: V2, q: V2): [V2, V2] {
  if (near(p, q, 1e-9)) throw new Error('The two points of the fold line are the same');
  return [p, q];
}

// ---------------------------------------------------------------------------
// Topology

function adjacent(f: Face, g: Face): [V2, V2] | null {
  if (f.sheet !== g.sheet) return null;
  for (let i = 0; i < f.poly.length; i++) {
    const a1 = f.poly[i], a2 = f.poly[(i + 1) % f.poly.length];
    for (let j = 0; j < g.poly.length; j++) {
      const b1 = g.poly[j], b2 = g.poly[(j + 1) % g.poly.length];
      if (segmentsOverlap(a1, a2, b1, b2, 1e-5)) return [a1, a2];
    }
  }
  return null;
}

function rerank(faces: { lb: number; la: number }[]) {
  const order = faces.map((f, i) => i).sort((i, j) => faces[i].lb - faces[j].lb || faces[i].la - faces[j].la);
  order.forEach((idx, rank) => (faces[idx].lb = rank));
}

function flatPoly(poly: V2[]): number[] {
  return poly.flatMap((p) => [round(p[0]), round(p[1])]);
}
const round = (x: number) => Math.round(x * 1e6) / 1e6;
const roundM = (m: Mat): Mat => m.map(round) as Mat;

function makePhase(motion: Phase['motion'], items: { f: Face; a: Mat; b: Mat; la: number; lb: number; d: number; extra?: Partial<PhaseFace> }[]): Phase {
  return {
    motion,
    faces: items.map((x) => ({
      id: x.f.id, s: x.f.sheet, p: flatPoly(x.f.poly), a: roundM(x.a), b: roundM(x.b), la: x.la, lb: x.lb, d: x.d, ...x.extra,
    })),
    lines: [],
    arrows: [],
  };
}

// ---------------------------------------------------------------------------
// Operations

function opFold(st: State, op: FoldOp): Phase {
  const kind: 'valley' | 'mountain' | 'crease-valley' | 'crease-mountain' | 'unfold' | 'inside' | 'outside' =
    op.reverse ? op.reverse
      : op.crease ? (op.crease === 'mountain' ? 'crease-mountain' : 'crease-valley')
        : op.unfold ? 'unfold'
          : op.fold === 'mountain' ? 'mountain' : 'valley';
  if (!op.line) throw new Error('A fold needs a line');
  let [p, q] = resolveLine(st, op.line);
  const isCrease = kind.startsWith('crease');
  let ref: V2 | null = op.move !== undefined ? resolvePoint(st, op.move) : null;
  if (!ref && !isCrease) throw new Error('Say which side moves with "move: <point>"');
  if (ref) {
    const s = side(ref, p, q);
    if (Math.abs(s) < 1e-6) throw new Error('The "move" point lies on the fold line');
    if (s < 0) [p, q] = [q, p];
  }
  const R = reflection(p, q);
  const sheetFilter = op.sheet ?? null;

  // 1. Split every face that the line crosses.
  type Piece = { f: Face; parent: number; left: boolean };
  const pieces: Piece[] = [];
  for (const f of st.faces) {
    if (sheetFilter && f.sheet !== sheetFilter) {
      pieces.push({ f, parent: f.id, left: false });
      continue;
    }
    const inv = invert(f.m);
    const pp = apply(inv, p), qq = apply(inv, q);
    // In paper space the orientation flips when the face is mirrored.
    const [l, r] = splitPolygon(f.poly, pp, qq);
    const mirrored = det(f.m) < 0;
    const leftPoly = mirrored ? r : l, rightPoly = mirrored ? l : r;
    if (leftPoly && rightPoly) {
      pieces.push({ f: { ...f, poly: orient(leftPoly), id: -1 }, parent: f.id, left: true });
      pieces.push({ f: { ...f, poly: orient(rightPoly), id: -1 }, parent: f.id, left: false });
    } else {
      pieces.push({ f, parent: f.id, left: side(apply(f.m, centroid(f.poly)), p, q) > 0 });
    }
  }

  // 2. Choose what moves: the layers at the reference point, plus everything connected
  //    to them on the moving side.
  const cand = pieces.filter((x) => x.left);
  let seeds: Piece[];
  if (ref) {
    seeds = cand.filter((x) => containsPoint(worldPoly(x.f), ref!, 1e-4));
    if (!seeds.length) throw new Error('There is no paper at the "move" point on the moving side');
  } else {
    seeds = cand.slice();
  }
  const choice: LayerChoice = op.layers ?? 'all';
  if (choice === 'top') {
    const mx = Math.max(...seeds.map((x) => x.f.layer));
    seeds = seeds.filter((x) => x.f.layer === mx);
  } else if (choice === 'bottom') {
    const mn = Math.min(...seeds.map((x) => x.f.layer));
    seeds = seeds.filter((x) => x.f.layer === mn);
  }
  const moving = new Set<Piece>(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const x = queue.pop()!;
    for (const y of cand) {
      if (moving.has(y)) continue;
      if (adjacent(x.f, y.f)) {
        moving.add(y);
        queue.push(y);
      }
    }
  }

  // 3. Merge back faces whose halves both stay put (no crease made there).
  const byParent = new Map<number, Piece[]>();
  for (const x of pieces) byParent.set(x.parent, [...(byParent.get(x.parent) ?? []), x]);
  const finalPieces: Piece[] = [];
  for (const [pid, list] of byParent) {
    if (list.length === 2 && !list.some((x) => moving.has(x))) {
      const orig = st.faces.find((f) => f.id === pid)!;
      finalPieces.push({ f: orig, parent: pid, left: false });
    } else {
      for (const x of list) {
        if (x.f.id === -1) x.f = { ...x.f, id: st.nextId++ };
        finalPieces.push(x);
      }
    }
  }

  // 4. New transforms and layers.
  const all = finalPieces.map((x) => x.f.layer);
  const maxAll = Math.max(...all), minAll = Math.min(...all);
  const mv = finalPieces.filter((x) => moving.has(x));
  const mvLayers = mv.map((x) => x.f.layer);
  const maxM = Math.max(...mvLayers), minM = Math.min(...mvLayers);
  const midM = (maxM + minM) / 2;

  const items = finalPieces.map((x) => {
    const f = x.f;
    const isMoving = moving.has(x);
    let b = f.m, lb = f.layer, d = 0;
    if (isMoving && !isCrease) {
      b = compose(R, f.m);
      switch (kind) {
        case 'valley':
          lb = maxAll + 1 + (maxM - f.layer); d = 1; break;
        case 'mountain':
          lb = minAll - 1 - (f.layer - minM); d = -1; break;
        case 'inside':
          // Pushed in between the layers, order reversed.
          lb = midM + (midM - f.layer) * 0.001; d = f.layer >= midM ? -1 : 1; break;
        case 'outside':
          if (f.layer >= midM) { lb = maxAll + 1 + (maxM - f.layer); d = 1; }
          else { lb = minAll - 1 - (f.layer - minM); d = -1; }
          break;
        case 'unfold': {
          // Lie back down next to the face it hinges on.
          const hinge = finalPieces.find((y) => !moving.has(y) && y.f.sheet === f.sheet && adjacent(y.f, f));
          lb = hinge ? hinge.f.layer + 0.0001 * (f.layer - minM) : f.layer;
          d = hinge && hinge.f.layer < f.layer ? 1 : -1;
          break;
        }
      }
    } else if (isMoving && isCrease) {
      d = kind === 'crease-mountain' ? -1 : 1;
    }
    return { f, a: f.m, b, la: f.layer, lb, d };
  });
  rerank(items);

  st.faces = items.map((x) => ({ ...x.f, m: x.b, layer: x.lb }));

  const phase = makePhase(isCrease ? 'crease' : 'hinge', items);
  phase.axis = [p, q];
  // Diagram: the fold line across the moving paper, and an arrow.
  const seg = clipToFaces(mv.map((x) => worldPoly({ ...x.f })), p, q);
  if (seg) {
    phase.lines.push({
      kind: kind === 'mountain' || kind === 'crease-mountain' ? 'mountain' : 'valley',
      p: seg[0], q: seg[1],
    });
  }
  if (ref) {
    phase.arrows.push({
      kind: kind === 'inside' || kind === 'outside' ? 'reverse' : kind === 'mountain' ? 'mountain' : 'valley',
      from: ref, to: apply(R, ref),
    });
  }
  return phase;
}

function orient(poly: V2[]): V2[] {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

function clipToFaces(polys: V2[][], p: V2, q: V2): [V2, V2] | null {
  let t0 = Infinity, t1 = -Infinity;
  for (const poly of polys) {
    const r = clipLineToPolygon(poly, p, q);
    if (r) { t0 = Math.min(t0, r[0]); t1 = Math.max(t1, r[1]); }
  }
  if (!isFinite(t0)) return null;
  const u = norm(sub(q, p));
  return [add(p, mul(u, t0)), add(p, mul(u, t1))];
}

function modelCenter(st: State, sheet?: string): V2 {
  const pts = st.faces.filter((f) => !sheet || f.sheet === sheet).flatMap(worldPoly);
  const b = bbox(pts);
  return lerp(b.min, b.max, 0.5);
}

function opTurnOver(st: State, axis: 'vertical' | 'horizontal'): Phase {
  const c = modelCenter(st);
  const p = c, q: V2 = axis === 'horizontal' ? [c[0] + 1, c[1]] : [c[0], c[1] + 1];
  const R = reflection(p, q);
  const items = st.faces.map((f) => ({ f, a: f.m, b: compose(R, f.m), la: f.layer, lb: -f.layer, d: 1 }));
  rerank(items);
  st.faces = items.map((x) => ({ ...x.f, m: x.b, layer: x.lb }));
  const phase = makePhase('hinge', items);
  phase.axis = [p, q];
  const b = bbox(items.flatMap((x) => worldPoly(x.f)));
  const r = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) * 0.35;
  phase.arrows.push({ kind: 'turn-over', from: [c[0] - r, b.min[1] - r * 0.3], to: [c[0] + r, b.min[1] - r * 0.3] });
  return phase;
}

function opRotate(st: State, degrees: number): Phase {
  const c = modelCenter(st);
  const Rm = rotation(c, degrees);
  const items = st.faces.map((f) => ({ f, a: f.m, b: compose(Rm, f.m), la: f.layer, lb: f.layer, d: 0 }));
  st.faces = items.map((x) => ({ ...x.f, m: x.b }));
  const phase = makePhase('spin', items);
  phase.center = c;
  phase.angle = degrees;
  const b = bbox(items.flatMap((x) => worldPoly(x.f)));
  const r = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) * 0.6;
  phase.arrows.push({ kind: 'rotate', from: add(c, [r, 0]), to: apply(rotation(c, Math.sign(degrees) * 40), add(c, [r, 0])) });
  return phase;
}

/** Split faces along a world line without moving anything. Returns the drawn segment. */
function splitAlong(st: State, sheet: string, p: V2, q: V2): [V2, V2] | null {
  const out: Face[] = [];
  const touched: V2[][] = [];
  for (const f of st.faces) {
    if (f.sheet !== sheet) { out.push(f); continue; }
    const inv = invert(f.m);
    const [l, r] = splitPolygon(f.poly, apply(inv, p), apply(inv, q));
    if (l && r) {
      out.push({ ...f, poly: orient(l), id: st.nextId++ }, { ...f, poly: orient(r), id: st.nextId++ });
      touched.push(worldPoly(f));
    } else out.push(f);
  }
  st.faces = out;
  return touched.length ? clipToFaces(touched, p, q) : null;
}

function opGrid(st: State, g: { n: number; m?: number; kind?: 'valley' | 'mountain'; diagonals?: 'none' | 'one' | 'both' }, sheet: string): Phase {
  const sh = st.sheets.get(sheet)!;
  const n = g.n, m = g.m ?? g.n;
  const before = st.faces.map((f) => ({ ...f }));
  const lines: DiagramLine[] = [];
  const kind = g.kind ?? 'valley';
  const W = (x: number, y: number) => literal(st, sheet, [x, y]);
  const add1 = (a: V2, b: V2, k: DiagramLine['kind']) => {
    const seg = splitAlong(st, sheet, a, b);
    if (seg) lines.push({ kind: k, p: seg[0], q: seg[1] });
  };
  for (let i = 1; i < n; i++) add1(W((sh.w * i) / n, 0), W((sh.w * i) / n, sh.h), kind);
  for (let j = 1; j < m; j++) add1(W(0, (sh.h * j) / m), W(sh.w, (sh.h * j) / m), kind);
  const dx = sh.w / n, dy = sh.h / m;
  if (g.diagonals === 'one' || g.diagonals === 'both') {
    for (let k = -(m - 1); k <= n - 1; k++) add1(W(k * dx, 0), W((k + 1) * dx, dy), kind === 'valley' ? 'mountain' : 'valley');
  }
  if (g.diagonals === 'both') {
    for (let k = 1; k <= n + m - 1; k++) add1(W(k * dx, 0), W((k - 1) * dx, dy), kind === 'valley' ? 'mountain' : 'valley');
  }
  void before;
  const items = st.faces.map((f) => ({ f, a: f.m, b: f.m, la: f.layer, lb: f.layer, d: 0 }));
  const phase = makePhase('none', items);
  phase.lines = lines;
  return phase;
}

function opCollapse(st: State, c: NonNullable<StepSpec['collapse']>, sheet: string): Phase {
  const faces0 = sheetFaces(st, sheet);
  const m0 = faces0[0].m;
  for (const f of faces0) {
    if (f.m.some((v, i) => Math.abs(v - m0[i]) > 1e-6)) throw new Error('Collapse needs the sheet to be flat (unfold it first)');
  }
  const inv0 = invert(m0);
  const toPaper = (e: PointExpr) => apply(inv0, resolvePoint(st, e));
  const creases: { a: V2; b: V2; kind: 'valley' | 'mountain' }[] = [
    ...(c.valley ?? []).map(fixList).map(([a, b]) => ({ a: toPaper(a), b: toPaper(b), kind: 'valley' as const })),
    ...(c.mountain ?? []).map(fixList).map(([a, b]) => ({ a: toPaper(a), b: toPaper(b), kind: 'mountain' as const })),
  ];
  // Split faces by every crease segment that fully crosses them.
  let faces = faces0.slice();
  for (const cr of creases) {
    const L = dist(cr.a, cr.b), u = norm(sub(cr.b, cr.a));
    const next: Face[] = [];
    for (const f of faces) {
      const r = clipLineToPolygon(f.poly, cr.a, cr.b);
      if (!r || r[0] >= L - 1e-5 || r[1] <= 1e-5) { next.push(f); continue; }
      if (r[0] < -1e-5 || r[1] > L + 1e-5) {
        const x = add(cr.a, mul(u, Math.max(0, r[0])));
        throw new Error(`Crease ends inside a face near (${x[0].toFixed(2)}, ${x[1].toFixed(2)}); pre-crease a grid or extend it`);
      }
      const [l, rr] = splitPolygon(f.poly, cr.a, cr.b);
      if (l && rr) next.push({ ...f, poly: orient(l), id: st.nextId++ }, { ...f, poly: orient(rr), id: st.nextId++ });
      else next.push(f);
    }
    faces = next;
  }
  const onCrease = (e: [V2, V2]) => creases.find((cr) => distToLine(e[0], cr.a, cr.b) < 1e-5 && distToLine(e[1], cr.a, cr.b) < 1e-5
    && segmentsOverlap(e[0], e[1], cr.a, cr.b, 1e-5));
  // Maekawa's theorem: at every interior vertex, mountains and valleys differ by two.
  {
    const sh = st.sheets.get(sheet)!;
    const counts = new Map<string, { p: V2; m: number; v: number }>();
    const seen = new Set<string>();
    const k = (p: V2) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      for (let j = 0; j < f.poly.length; j++) {
        const a = f.poly[j], b = f.poly[(j + 1) % f.poly.length];
        const cr = onCrease([a, b]);
        if (!cr) continue;
        const ek = [k(a), k(b)].sort().join('|');
        if (seen.has(ek)) continue;
        seen.add(ek);
        for (const p of [a, b]) {
          const c = counts.get(k(p)) ?? { p, m: 0, v: 0 };
          if (cr.kind === 'mountain') c.m++; else c.v++;
          counts.set(k(p), c);
        }
      }
    }
    for (const c of counts.values()) {
      const onEdge = c.p[0] < 1e-5 || c.p[1] < 1e-5 || c.p[0] > sh.w - 1e-5 || c.p[1] > sh.h - 1e-5;
      if (!onEdge && Math.abs(c.m - c.v) !== 2) {
        throw new Error(`These creases do not fold flat: ${c.m} mountain and ${c.v} valley folds meet at (${c.p[0].toFixed(1)}, ${c.p[1].toFixed(1)}); they must differ by 2`);
      }
    }
  }
  // Root face.
  const fixedP = c.fixed !== undefined ? toPaper(c.fixed) : [st.sheets.get(sheet)!.w / 2, st.sheets.get(sheet)!.h / 2] as V2;
  let root = faces.findIndex((f) => containsPoint(f.poly, fixedP, 1e-4));
  if (root < 0) root = 0;
  const s = det(m0) > 0 ? 1 : -1;
  const T: (Mat | null)[] = faces.map(() => null); // paper -> paper folding map
  const Z: number[] = faces.map(() => 0);
  const parent: number[] = faces.map(() => -1);
  const hinge: ([V2, V2] | null)[] = faces.map(() => null);
  const ang: number[] = faces.map(() => 0);
  T[root] = IDENTITY;
  const queue = [root];
  const adj = faces.map((f, i) => faces.map((g, j) => (i !== j ? adjacent(f, g) : null)));
  while (queue.length) {
    const i = queue.shift()!;
    for (let j = 0; j < faces.length; j++) {
      const e = adj[i][j];
      if (!e) continue;
      const cr = onCrease(e);
      const Tj = cr ? compose(T[i]!, reflection(e[0], e[1])) : T[i]!;
      if (T[j]) {
        if (T[j]!.some((v, k) => Math.abs(v - Tj[k]) > 1e-4)) {
          const x = centroid(faces[j].poly);
          throw new Error(`These creases do not fold flat (conflict near ${x[0].toFixed(1)}, ${x[1].toFixed(1)})`);
        }
        continue;
      }
      T[j] = Tj;
      parent[j] = i;
      if (cr) {
        const towardFront = cr.kind === 'valley' ? s > 0 : s < 0;
        const parentFrontUp = det(compose(m0, T[i]!)) > 0;
        Z[j] = Z[i] + (towardFront === parentFrontUp ? 1 : -1);
        // Orient the hinge so the child lies to its left.
        const cc = centroid(faces[j].poly);
        hinge[j] = side(cc, e[0], e[1]) > 0 ? [e[0], e[1]] : [e[1], e[0]];
        ang[j] = towardFront ? Math.PI : -Math.PI;
      } else {
        Z[j] = Z[i];
        hinge[j] = null;
      }
      queue.push(j);
    }
  }
  if (T.some((t) => !t)) throw new Error('Some parts of the sheet are not connected');
  const others = st.faces.filter((f) => f.sheet !== sheet);
  const base = Math.max(-1, ...others.map((f) => f.layer)) + 1;
  const items = [
    ...others.map((f) => ({ f, a: f.m, b: f.m, la: f.layer, lb: f.layer, d: 0, extra: {} as Partial<PhaseFace> })),
    ...faces.map((f, i) => ({
      f, a: m0, b: compose(m0, T[i]!), la: f.layer, lb: base + Z[i] * 0.01 + f.layer * 1e-6, d: 0,
      extra: {
        parent: parent[i] < 0 ? -1 : parent[i] + others.length,
        hinge: hinge[i] ? [hinge[i]![0][0], hinge[i]![0][1], hinge[i]![1][0], hinge[i]![1][1]] as [number, number, number, number] : undefined,
        ang: ang[i],
      } as Partial<PhaseFace>,
    })),
  ];
  rerank(items);
  st.faces = items.map((x) => ({ ...x.f, m: x.b, layer: x.lb }));
  const phase = makePhase('chain', items);
  phase.lines = creases.map((cr) => ({ kind: cr.kind, p: apply(m0, cr.a), q: apply(m0, cr.b) }));
  return phase;
}

function opPlace(st: State, pl: NonNullable<StepSpec['place']>): Phase {
  const sh = st.sheets.get(pl.sheet);
  if (!sh) throw new Error(`Unknown sheet "${pl.sheet}"`);
  const prevActive = st.active;
  st.active = pl.sheet;
  let T: Mat = IDENTITY;
  const c = modelCenter(st, pl.sheet);
  if (pl.flip) T = compose(reflection(c, add(c, [0, 1])), T);
  if (pl.rotate) T = compose(rotation(c, pl.rotate), T);
  if (pl.point !== undefined && pl.to !== undefined) {
    const from = apply(T, resolvePoint(st, pl.point));
    st.active = prevActive;
    const to = resolvePoint(st, pl.to);
    T = compose(translation(sub(to, from)), T);
  }
  st.active = prevActive;
  const mine = st.faces.filter((f) => f.sheet === pl.sheet);
  const rest = st.faces.filter((f) => f.sheet !== pl.sheet);
  const restMax = Math.max(0, ...rest.map((f) => f.layer)), restMin = Math.min(0, ...rest.map((f) => f.layer));
  const mineMin = Math.min(...mine.map((f) => f.layer)), mineMax = Math.max(...mine.map((f) => f.layer));
  const items = st.faces.map((f) => {
    if (f.sheet !== pl.sheet) return { f, a: f.m, b: f.m, la: f.layer, lb: f.layer, d: 0 };
    let lb = f.layer;
    if (pl.flip) lb = mineMax - (f.layer - mineMin);
    if (pl.layer === 'above') lb = restMax + 1 + (lb - mineMin);
    if (pl.layer === 'below') lb = restMin - 1 - (mineMax - lb);
    return { f, a: f.m, b: compose(T, f.m), la: f.layer, lb, d: 0 };
  });
  rerank(items);
  st.faces = items.map((x) => ({ ...x.f, m: x.b, layer: x.lb }));
  return makePhase('move', items);
}

function opMark(st: State, mark: Record<string, PointExpr>) {
  for (const [name, e] of Object.entries(mark)) {
    const w = resolvePoint(st, e);
    const { sheet, p } = worldToPaper(st, st.active, w);
    st.sheets.get(sheet)!.names.set(name, p);
  }
}

// ---------------------------------------------------------------------------
// Steps

function opsOf(step: StepSpec): Op[] {
  // Marks and pins are taken first, before the step's folds move anything.
  const ops: Op[] = step.mark ? [{ mark: step.mark }] : [];
  if (step.pin) ops.unshift({ pin: step.pin } as unknown as Op);
  ops.push(...(step.ops ?? []));
  if (step.fold || step.crease || step.unfold || step.reverse) {
    const { fold, crease, unfold, reverse, line, move, layers, sheet } = step;
    ops.push({ fold, crease, unfold, reverse, line, move, layers, sheet });
  }
  if (step['turn-over']) ops.push({ 'turn-over': step['turn-over'] });
  if (step.rotate !== undefined) ops.push({ rotate: step.rotate });
  if (step.grid) ops.push({ grid: step.grid, sheet: step.sheet });
  if (step.collapse) ops.push({ collapse: step.collapse, sheet: step.sheet });
  if (step.place) ops.push({ place: step.place });
  return ops;
}

function defaultText(ops: Op[]): string {
  const op = ops.find((o) => !('mark' in o));
  if (!op) return '';
  if ('turn-over' in op) return 'Turn the model over.';
  if ('rotate' in op) return `Rotate the model ${Math.abs(op.rotate)}°.`;
  if ('grid' in op) return `Crease a ${op.grid.n} × ${op.grid.m ?? op.grid.n} grid.`;
  if ('collapse' in op) return 'Collapse along the creases.';
  if ('place' in op) return 'Put the pieces together.';
  const f = op as FoldOp;
  if (f.reverse) return `${f.reverse === 'inside' ? 'Inside' : 'Outside'} reverse fold.`;
  if (f.crease) return `${f.crease === 'mountain' ? 'Mountain' : 'Valley'} fold and unfold.`;
  if (f.unfold) return 'Unfold.';
  return `${f.fold === 'mountain' ? 'Mountain' : 'Valley'} fold.`;
}

const PRESETS: Record<CameraPreset, CameraSpec> = {
  top: { preset: 'top', azimuth: 0, elevation: 72, zoom: 1 },
  'three-quarter': { preset: 'three-quarter', azimuth: -30, elevation: 45, zoom: 1 },
  front: { preset: 'front', azimuth: 0, elevation: 12, zoom: 1 },
  side: { preset: 'side', azimuth: 90, elevation: 15, zoom: 1 },
  bottom: { preset: 'bottom', azimuth: 0, elevation: -72, zoom: 1 },
  hero: { preset: 'hero', azimuth: -12, elevation: 62, zoom: 1.15 },
};

function camera(spec: StepSpec['camera'] | undefined, fallback: CameraSpec): CameraSpec {
  if (!spec) return fallback;
  if (typeof spec === 'string') return PRESETS[spec] ?? fallback;
  const base = spec.preset ? PRESETS[spec.preset] : fallback;
  return { ...base, ...spec };
}

function parseSize(size: string | number): [number, number] {
  if (typeof size === 'number') return [size, size];
  const m = String(size).replace(/cm/g, '').split(/[x×]/).map((s) => Number(s.trim()));
  if (m.some((v) => !isFinite(v) || v <= 0)) throw new Error(`Bad paper size "${size}"`);
  return m.length === 1 ? [m[0], m[0]] : [m[0], m[1]];
}

export function compileModel(script: ModelScript, bases: BaseLibrary = {}): CompiledModel {
  if (!script.materials?.length) throw new CompileError(-1, 'A model needs at least one sheet in "materials"');
  const st: State = { faces: [], pins: new Map(), sheets: new Map(), active: script.materials[0].id, nextId: 1 };
  let x = 0;
  let layer = 0;
  const sheets: SheetInfo[] = [];
  for (const mat of script.materials) {
    const [w, h] = parseSize(mat.size);
    const at: V2 = mat.at ?? [x, 0];
    x = at[0] + w * 1.25;
    const backUp = (mat.start ?? 'back-up') === 'back-up';
    // Back-up start: the sheet is mirrored so its back (usually white) faces the viewer.
    const m0: Mat = backUp ? compose(translation(at), [-1, 0, 0, 1, w, 0]) : translation(at);
    const names = new Map<string, V2>();
    const inv = invert(m0);
    const corner = (wx: number, wy: number) => apply(inv, [at[0] + wx, at[1] + wy]);
    names.set('A', corner(0, h));
    names.set('B', corner(w, h));
    names.set('C', corner(w, 0));
    names.set('D', corner(0, 0));
    names.set('O', corner(w / 2, h / 2));
    let mStart = m0;
    if (mat.diamond) mStart = compose(rotation([at[0] + w / 2, at[1] + h / 2], -45), m0);
    const info: Sheet = {
      id: mat.id, name: mat.name ?? mat.id, w, h,
      front: mat.colors?.front ?? DEFAULT_FRONT, back: mat.colors?.back ?? DEFAULT_BACK,
      count: mat.count ?? 1, note: mat.note, names, m0: mStart,
    };
    st.sheets.set(mat.id, info);
    sheets.push({ id: info.id, name: info.name, w, h, front: info.front, back: info.back, count: info.count, note: info.note });
    st.faces.push({ id: st.nextId++, sheet: mat.id, poly: [[0, 0], [w, 0], [w, h], [0, h]], m: mStart, layer: layer++ });
  }

  // Expand `use:` references to reusable bases.
  const flat: { step: StepSpec; group?: string }[] = [];
  const expand = (steps: StepSpec[], group?: string, depth = 0) => {
    for (const s of steps) {
      if (s.use) {
        const base = bases[s.use];
        if (!base) throw new CompileError(flat.length, `Unknown base "${s.use}"`);
        if (depth > 5) throw new CompileError(flat.length, 'Bases nested too deeply');
        expand(base.steps, group ?? base.title, depth + 1);
      } else flat.push({ step: s, group });
    }
  };
  expand(script.steps);

  const steps: CompiledStep[] = [];
  let cam: CameraSpec = PRESETS.top;
  flat.forEach(({ step, group }, i) => {
    try {
      if (step.sheet) st.active = step.sheet;
      const ops = opsOf(step);
      const phases: Phase[] = [];
      for (const op of ops) {
        if ('mark' in op) { opMark(st, op.mark); continue; }
        if ('pin' in op) { for (const [k, e] of Object.entries((op as { pin: Record<string, PointExpr> }).pin)) st.pins.set(k, resolvePoint(st, e)); continue; }
        if ('turn-over' in op) { phases.push(opTurnOver(st, op['turn-over'] === 'horizontal' ? 'horizontal' : 'vertical')); continue; }
        if ('rotate' in op) { phases.push(opRotate(st, op.rotate)); continue; }
        if ('grid' in op) { phases.push(opGrid(st, op.grid, op.sheet ?? st.active)); continue; }
        if ('collapse' in op) { phases.push(opCollapse(st, op.collapse, op.sheet ?? st.active)); continue; }
        if ('place' in op) { phases.push(opPlace(st, op.place)); continue; }
        const f = op as FoldOp;
        if (f.sheet) st.active = f.sheet;
        phases.push(opFold(st, f));
      }
      cam = camera(step.camera, cam);
      steps.push({ text: step.text ?? defaultText(ops), tip: step.tip, group, camera: cam, phases });
    } catch (e) {
      if (e instanceof CompileError) throw e;
      throw new CompileError(i, (e as Error).message);
    }
  });

  const ext = Math.max(...sheets.map((s) => Math.max(s.w, s.h)));
  return {
    id: script.id,
    title: script.title,
    family: script.family,
    variant: script.variant,
    aliases: script.aliases ?? [],
    categories: script.categories ?? [],
    tags: script.tags ?? [],
    difficulty: script.difficulty,
    description: script.description ?? '',
    credits: script.credits,
    sheets,
    tools: script.tools ?? [],
    steps,
    finish: { camera: camera(script.finish?.camera, PRESETS.hero), text: script.finish?.text ?? 'Finished!' },
    extent: ext,
  };
}

/** Final folded faces of a compiled model (end of the last phase). */
export function finalFaces(model: CompiledModel): PhaseFace[] {
  for (let i = model.steps.length - 1; i >= 0; i--) {
    const ph = model.steps[i].phases;
    if (ph.length) return ph[ph.length - 1].faces;
  }
  return [];
}

export { cross };
