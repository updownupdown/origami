// Compiles an authored fold script into per-step geometry the viewer can animate.
//
// Model: every face of the folded paper is a convex polygon in paper space plus a
// 2D isometry (paper -> world) and an integer layer. Flat folds reflect faces across
// a line; layers are re-ranked after each operation. This is exact for flat-folded
// states; the motion between states is an approximation (see docs/fidelity.md).

import { checkOrder, solveLayers, type LayerCrease } from './layers.ts';
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
  /** Current whole-model tilt (stand), degrees about the line p→q. */
  tilt: { p: V2; q: V2; a: number } | null;
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
    case 'bisect':
      return bisectPoint(pt(0), pt(1), pt(2));
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

/**
 * A point expression read on the unfolded sheet: names are points of the paper, and the functions
 * work in the crease pattern's own coordinates (see `refold`).
 */
function evalPaper(st: State, sheet: string, a: Ast): V2 | number {
  if (a.k === 'num') return a.v;
  const sh = st.sheets.get(sheet)!;
  if (a.k === 'name') {
    if (st.pins.has(a.v)) throw new Error(`"${a.v}" is a pin (a point in space); a point of the paper is needed here`);
    const hit = lookupName(st, a.v);
    if (hit.sheet !== sheet) throw new Error(`"${a.v}" is on sheet "${hit.sheet}", not "${sheet}"`);
    return hit.p;
  }
  const args = a.args.map((x) => evalPaper(st, sheet, x));
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
    case 'mid': return lerp(pt(0), pt(1), 0.5);
    case 'lerp': return lerp(pt(0), pt(1), num(2));
    case 'intersect': {
      const x = lineIntersection(pt(0), pt(1), pt(2), pt(3));
      if (!x) throw new Error('intersect(): lines are parallel');
      return x;
    }
    case 'reflect': return apply(reflection(pt(1), pt(2)), pt(0));
    case 'project': { const p = pt(1), u = norm(sub(pt(2), p)); return add(p, mul(u, dot(sub(pt(0), p), u))); }
    case 'bisect': return bisectPoint(pt(0), pt(1), pt(2));
    case 'paper': {
      const origin: V2 = bbox(cornerWorld0(sh)).min;
      return apply(invert(sh.m0), add(origin, [num(0), num(1)]));
    }
    default: throw new Error(`${a.f}() can't be used for a point of the unfolded sheet`);
  }
}

function resolvePaper(st: State, sheet: string, e: PointExpr): V2 {
  if (Array.isArray(e)) {
    const sh = st.sheets.get(sheet)!;
    return apply(invert(sh.m0), add(bbox(cornerWorld0(sh)).min, e as V2));
  }
  const v = evalPaper(st, sheet, parseExpr(String(e)));
  if (!Array.isArray(v)) throw new Error(`"${e}" is a number, not a point`);
  return v;
}

/** bisect(V, P, Q): where the line halving the angle P-V-Q meets the segment P-Q. */
function bisectPoint(v: V2, p: V2, q: V2): V2 {
  const a = dist(v, p), b = dist(v, q);
  if (a + b < 1e-9) throw new Error('bisect(): the three points coincide');
  return lerp(p, q, a / (a + b));
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
      id: x.f.id, s: x.f.sheet, p: flatPoly(x.f.poly), a: roundM(x.a), b: roundM(x.b), la: x.la, lb: x.lb, d: x.d,
      ...(x.f.anchor ? { k: 1 as const } : {}), ...x.extra,
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
          : op.fold === 'both' ? 'outside' : op.fold === 'mountain' ? 'mountain' : 'valley';
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
  } else if (choice === 'outer') {
    const mn = Math.min(...seeds.map((x) => x.f.layer)), mx = Math.max(...seeds.map((x) => x.f.layer));
    seeds = seeds.filter((x) => x.f.layer === mn || x.f.layer === mx);
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
  // The flap's two halves for a reverse fold: the upper and lower half of its layers by count
  // (a narrow flap is folded in half, so each half holds as many layers as the other).
  const srt = mvLayers.slice().sort((a, b) => a - b);
  const midM = (srt[(srt.length - 1) >> 1] + srt[srt.length >> 1]) / 2;

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
          // Pushed in between the layers. Each half of the flap turns over on its own, so its
          // layers come out in reverse order (the flap is turned inside out), and the front half
          // stays in front of the back half.
          lb = f.layer >= midM ? midM + (maxM - f.layer + 0.5) * 0.001 : midM - (f.layer - minM + 0.5) * 0.001;
          d = f.layer >= midM ? -1 : 1; break;
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
  if (!isCrease) settleLayers(st, items);

  st.faces = items.map((x) => ({ ...x.f, m: x.b, layer: x.lb }));

  const phase = makePhase(isCrease ? 'crease' : 'hinge', items);
  phase.axis = [p, q];
  if (op.name) phase.name = op.name;
  if (op.reverse) {
    // The flap's spine: the longest edge joining its two halves, where they were before the fold.
    let best: [V2, V2] | null = null, bestLen = 0;
    for (const x of mv) for (const y of mv) {
      if (x.f.layer >= midM === y.f.layer >= midM || x.f.layer < y.f.layer) continue;
      const e = adjacent(x.f, y.f);
      if (!e) continue;
      const w: [V2, V2] = [apply(x.f.m, e[0]), apply(x.f.m, e[1])];
      const l = dist(w[0], w[1]);
      if (l > bestLen) { bestLen = l; best = w; }
    }
    const V = best && lineIntersection(best[0], best[1], p, q);
    if (best && V) {
      const far = side(best[0], p, q) > side(best[1], p, q) ? best[0] : best[1];
      if (dist(far, V) > 1e-6) phase.spine = [V, far];
    }
  }
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

/**
 * Checks the layer order a fold left with the layer solver, sheet by sheet, and repairs it if paper
 * would pass through paper. Every crease keeps the side the fold gave it; the solver then keeps
 * every other pair as the fold ordered it wherever it can, so a correct order comes back unchanged.
 * If even the creases can't be ordered (the fold itself is impossible), the fold's order stays.
 */
function settleLayers(st: State, items: { f: Face; b: Mat; lb: number }[]) {
  for (const sheet of new Set(items.map((x) => x.f.sheet))) {
    const F = items.filter((x) => x.f.sheet === sheet);
    if (F.length < 3 || F.length > 400) continue;
    const sh = st.sheets.get(sheet)!;
    const r = checkOrder(F.map((x) => ({ poly: x.f.poly, T: x.b, layer: x.lb })), Math.max(sh.w, sh.h));
    if (!r || !r.changed) continue;
    // Same slots in the stack (so other sheets keep their places), in the solved order.
    const slots = F.map((x) => x.lb).sort((a, b) => a - b);
    const order = F.map((_, i) => i).sort((i, j) => r.layer[i] - r.layer[j] || F[i].lb - F[j].lb);
    order.forEach((i, k) => (F[i].lb = slots[k]));
  }
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

/** Splits faces (paper space) by crease segments that fully cross them; a segment may not end inside a face. */
function splitBySegments(st: State, faces0: Face[], creases: { a: V2; b: V2 }[]): Face[] {
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
  return faces;
}

/**
 * Creases a whole crease pattern into a flat sheet (each segment must end on an edge or on another
 * crease), then optionally shapes it: every crease folds to `angle` degrees at once. For tessellations
 * and boxes that are shaped in 3D rather than folded flat.
 */
function opPattern(st: State, pt: NonNullable<StepSpec['pattern']>, sheet: string): Phase[] {
  const faces0 = sheetFaces(st, sheet);
  const m0 = faces0[0].m;
  for (const f of faces0) {
    if (f.m.some((v, i) => Math.abs(v - m0[i]) > 1e-6)) throw new Error('pattern needs the sheet to be flat (unfold it first)');
  }
  const inv0 = invert(m0);
  const toPaper = (e: PointExpr) => apply(inv0, resolvePoint(st, e));
  // Each segment is [P, Q] or [P, Q, angle] (its own fold angle in degrees).
  const seg = (kind: 'valley' | 'mountain') => (x: unknown) => {
    const arr = x as unknown[];
    const ang = arr.length === 3 && typeof arr[2] === 'number' ? (arr[2] as number) : undefined;
    const [a, b] = fixList((ang === undefined ? arr : arr.slice(0, 2)) as [PointExpr, PointExpr]);
    return { a: toPaper(a), b: toPaper(b), kind, angle: ang };
  };
  const creases = [...(pt.valley ?? []).map(seg('valley')), ...(pt.mountain ?? []).map(seg('mountain'))];
  if (!creases.length) throw new Error('pattern needs some valley or mountain segments');
  const faces = splitBySegments(st, faces0, creases);
  st.faces = [...st.faces.filter((f) => f.sheet !== sheet), ...faces];
  const lines: DiagramLine[] = creases.map((cr) => ({ kind: cr.kind, p: apply(m0, cr.a), q: apply(m0, cr.b) }));
  const crease = stillPhase(st, 'none');
  crease.lines = lines;
  if (pt.angle === undefined && creases.every((c) => c.angle === undefined)) return [crease];
  if (pt.fixed !== undefined) {
    const w = resolvePoint(st, pt.fixed);
    st.faces = st.faces.map((f) => ({ ...f, anchor: f.sheet === sheet && containsPoint(worldPoly(f), w, 1e-4) }));
  }
  const shape = stillPhase(st, 'shape');
  const anyAnchor = st.faces.some((f) => f.anchor);
  shape.faces.forEach((f) => (f.d = anyAnchor && !f.k ? 1 : 0));
  shape.shape = lines.map((l, i) => ({ p: l.p, q: l.q, kind: l.kind as 'valley' | 'mountain', angle: creases[i].angle ?? pt.angle ?? 180 }));
  if (pt.name) shape.name = pt.name;
  return [crease, shape];
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
  let faces = splitBySegments(st, faces0, creases);
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
  // Layer order: solved so no paper passes through paper (the tree's running count is only a guess,
  // and is wrong for bases like the bird base).
  {
    const lc: LayerCrease[] = [];
    for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) {
      const e = adj[i][j];
      const cr = e && onCrease(e);
      if (!e || !cr) continue;
      const towardFront = cr.kind === 'valley' ? s > 0 : s < 0;
      const iFrontUp = det(compose(m0, T[i]!)) > 0;
      lc.push({ f: i, g: j, a: e[0], b: e[1], above: towardFront === iFrontUp ? 1 : -1 });
    }
    const sh = st.sheets.get(sheet)!;
    // World "up" may be the paper's back (a flipped sheet): layers count up the world.
    const solved = solveLayers(faces.map((f, i) => ({ poly: f.poly, T: T[i]! })), lc.map((c) => (s > 0 ? c : { ...c, above: -c.above })), Math.max(sh.w, sh.h));
    if (!solved) throw new Error('These creases fold flat, but no layer order keeps the paper from passing through itself');
    solved.layer.forEach((l, i) => (Z[i] = s > 0 ? l : -l));
  }
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

/**
 * Changes several creases of an already folded sheet at once and folds it flat again (a squash, a
 * petal fold, a sink). The crease pattern is the state: creases are added, opened flat or turned the
 * other way, the folded shape follows by reflecting across every folded crease out from the face
 * that stays still, and the layer solver finds the order that keeps paper from passing through
 * paper, keeping every untouched crease and as much of the old order as it can.
 */
function opRefold(st: State, c: NonNullable<StepSpec['refold']>, sheet: string): Phase {
  const sh = st.sheets.get(sheet);
  if (!sh) throw new Error(`Unknown sheet "${sheet}"`);
  const P = (e: PointExpr) => resolvePaper(st, sheet, e);
  const segs = (list: [PointExpr, PointExpr][] | undefined) => (list ?? []).map(fixList).map(([a, b]) => ({ a: P(a), b: P(b) }));
  const added = [
    ...segs(c.valley).map((x) => ({ ...x, kind: 'valley' as const })),
    ...segs(c.mountain).map((x) => ({ ...x, kind: 'mountain' as const })),
    ...segs(c.fold).map((x) => ({ ...x, kind: 'either' as const })),
  ];
  const flatten = segs(c.flatten), flip = segs(c.flip);
  const before = sheetFaces(st, sheet);
  const faces = splitBySegments(st, before, added);
  const n = faces.length;
  const on = <T extends { a: V2; b: V2 }>(list: T[], e: [V2, V2]) => list.find((cr) => distToLine(e[0], cr.a, cr.b) < 1e-5 && distToLine(e[1], cr.a, cr.b) < 1e-5
    && segmentsOverlap(e[0], e[1], cr.a, cr.b, 1e-5));
  const same = (x: Mat, y: Mat) => x.every((v, k) => Math.abs(v - y[k]) < 1e-5);
  const adj = faces.map((f, i) => faces.map((g, j) => (i !== j ? adjacent(f, g) : null)));
  // What each crease does: 0 stays flat, 1 stays folded, 2 newly folded, 3 opens flat, 4 turns over.
  const used = new Set<object>();
  const role = (i: number, j: number): number => {
    const e = adj[i][j]!;
    const was = !same(faces[i].m, faces[j].m);
    const add = on(added, e), fl = on(flatten, e), tv = on(flip, e);
    for (const x of [add, fl, tv]) if (x) used.add(x);
    if (was) {
      if (add) throw new Error('refold: a crease listed as new is already folded; list it under "flip" to turn it the other way');
      return fl ? 3 : tv ? 4 : 1;
    }
    if (fl || tv) throw new Error('refold: a crease listed under "flatten" or "flip" is not folded');
    return add ? 2 : 0;
  };
  // The face to fold out from: under the fixed point if one is given (settled below otherwise).
  let root = 0;
  if (c.fixed !== undefined) {
    const fp = P(c.fixed);
    root = faces.findIndex((f) => containsPoint(f.poly, fp, 1e-4));
    if (root < 0) throw new Error('refold: there is no paper at the "fixed" point');
  }
  const M: (Mat | null)[] = faces.map(() => null);
  M[root] = faces[root].m;
  const queue = [root];
  while (queue.length) {
    const i = queue.shift()!;
    for (let j = 0; j < n; j++) {
      const e = adj[i][j];
      if (!e) continue;
      const r = role(i, j);
      const Mj = r === 0 || r === 3 ? M[i]! : compose(M[i]!, reflection(e[0], e[1]));
      if (M[j]) {
        if (!M[j]!.every((v, k) => Math.abs(v - Mj[k]) < 1e-4)) {
          const x = centroid(faces[j].poly);
          throw new Error(`refold: these creases do not fold flat (conflict near ${x[0].toFixed(1)}, ${x[1].toFixed(1)} on the unfolded sheet)`);
        }
        continue;
      }
      M[j] = Mj;
      queue.push(j);
    }
  }
  if (M.some((m) => !m)) throw new Error('refold: some parts of the sheet are not connected');
  if (c.fixed === undefined) {
    // No fixed point: hold still whatever leaves the most paper where it is (the lowest such face).
    let best = Infinity, bestLayer = Infinity, G: Mat = IDENTITY;
    for (let r = 0; r < n; r++) {
      const Gr = compose(faces[r].m, invert(M[r]!));
      let area = 0;
      for (let i = 0; i < n; i++) if (!same(faces[i].m, compose(Gr, M[i]!))) area += Math.abs(signedArea(faces[i].poly));
      if (area < best - 1e-9 || (area < best + 1e-9 && faces[r].layer < bestLayer)) { best = area; bestLayer = faces[r].layer; G = Gr; }
    }
    for (let i = 0; i < n; i++) M[i] = compose(G, M[i]!);
  }
  for (const x of [...added, ...flatten, ...flip]) {
    if (!used.has(x)) throw new Error(`refold: no crease of the sheet lies on the segment (${x.a[0].toFixed(2)}, ${x.a[1].toFixed(2)}) to (${x.b[0].toFixed(2)}, ${x.b[1].toFixed(2)})`);
  }
  // Creases: each keeps the side of the paper it folds towards, unless it is new or turned over.
  const up = (m: Mat) => det(m) > 0;
  const lc: LayerCrease[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const e = adj[i][j];
    if (!e) continue;
    const r = role(i, j);
    if (r === 0 || r === 3) continue;
    let above = 0;
    if (r === 1 || r === 4) {
      // j lay on this side of i's paper; it still does (or the other side, if turned over).
      const was = faces[j].layer > faces[i].layer ? 1 : -1;
      above = (up(M[i]!) === up(faces[i].m) ? was : -was) * (r === 4 ? -1 : 1);
    } else {
      const kind = on(added, e)!.kind;
      // A valley brings together the sides of the paper that face up now.
      if (kind !== 'either') above = (up(M[i]!) === up(faces[i].m)) === (kind === 'valley') ? 1 : -1;
    }
    lc.push({ f: i, g: j, a: e[0], b: e[1], above });
  }
  const moved = faces.map((f, i) => !same(f.m, M[i]!));
  const prefer = (i: number, j: number): number => {
    const was = faces[i].layer > faces[j].layer ? 1 : -1;
    if (!moved[i] && !moved[j]) return was;
    // Paper that moves lands on top of paper that stays.
    if (moved[i] !== moved[j]) return moved[i] ? 1 : -1;
    // Two faces carried along together keep their order, seen from their own side.
    return up(M[i]!) === up(faces[i].m) ? was : -was;
  };
  const solved = solveLayers(faces.map((f, i) => ({ poly: f.poly, T: M[i]! })), lc, Math.max(sh.w, sh.h), prefer);
  if (!solved) throw new Error('refold: these creases fold flat, but no layer order keeps the paper from passing through itself');
  // The sheet keeps its place among the other sheets.
  const lo = Math.min(...before.map((f) => f.layer)), hi = Math.max(...before.map((f) => f.layer));
  const span = Math.max(1, ...solved.layer) + 1;
  const mine = new Map(faces.map((f, i) => [f, i]));
  const items = [...st.faces.filter((f) => f.sheet !== sheet), ...faces].map((f) => {
    const i = mine.get(f);
    if (i === undefined) return { f, a: f.m, b: f.m, la: f.layer, lb: f.layer, d: 0 };
    return { f, a: f.m, b: M[i]!, la: f.layer, lb: lo + ((hi - lo + 0.5) * solved.layer[i]) / span, d: moved[i] ? 1 : 0 };
  });
  rerank(items);
  const phase = makePhase('refold', items);
  // Diagram lines: the new creases that can be seen, where they lie now.
  const topAt = (w: V2) => {
    let best: Face | null = null;
    for (const f of st.faces) if (containsPoint(worldPoly(f), w, 1e-4) && (!best || f.layer > best.layer)) best = f;
    return best;
  };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const e = adj[i][j];
    if (!e || role(i, j) !== 2) continue;
    const parent = before.find((f) => containsPoint(f.poly, centroid(faces[i].poly), 1e-6));
    const mid = apply(faces[i].m, lerp(e[0], e[1], 0.5));
    if (!parent || topAt(apply(faces[i].m, centroid(faces[i].poly))) !== parent || topAt(mid)?.layer !== parent.layer) continue;
    const jAbove = items[st.faces.length - before.length + j].lb > items[st.faces.length - before.length + i].lb;
    const valley = (up(M[i]!) === up(faces[i].m)) === jAbove;
    phase.lines.push({ kind: valley ? 'valley' : 'mountain', p: apply(faces[i].m, e[0]), q: apply(faces[i].m, e[1]) });
  }
  if (c.arrow) {
    const [from, to] = fixList(c.arrow);
    phase.arrows.push({ kind: 'valley', from: resolvePoint(st, from), to: resolvePoint(st, to) });
  }
  st.faces = items.map((x) => ({ ...x.f, m: x.b, layer: x.lb }));
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

/** Picks a folded sheet up and sets it down in 3D (see PoseOp). The flat diagram does not change. */
function opPose(st: State, po: NonNullable<StepSpec['pose']>): Phase {
  if (!st.sheets.get(po.sheet)) throw new Error(`Unknown sheet "${po.sheet}"`);
  const prevActive = st.active;
  st.active = po.sheet;
  const p = resolvePoint(st, po.point), a = resolvePoint(st, po.along);
  st.active = prevActive;
  const to = resolvePoint(st, po.to);
  const len = dist(p, a);
  if (len < 1e-6) throw new Error('pose: "point" and "along" must be two different points');
  const rad = Math.PI / 180, L = (po.lean ?? 0) * rad, phi = (po.toward ?? 0) * rad, tau = (po.turn ?? 0) * rad;
  type V3 = [number, number, number];
  const cross = (x: V3, y: V3): V3 => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  // The sheet's own axes as it lies now: its "up", the side facing the viewer, and across.
  const u: V3 = [(a[0] - p[0]) / len, (a[1] - p[1]) / len, 0], n: V3 = [0, 0, 1], b = cross(n, u);
  // And where they end: "up" leaning from the vertical, the upper side facing the middle and the sky.
  const u1: V3 = [Math.sin(L) * Math.cos(phi), Math.sin(L) * Math.sin(phi), Math.cos(L)];
  const n0: V3 = [-Math.cos(L) * Math.cos(phi), -Math.cos(L) * Math.sin(phi), Math.sin(L)], w = cross(u1, n0);
  const n1: V3 = [0, 1, 2].map((i) => n0[i] * Math.cos(tau) + w[i] * Math.sin(tau)) as V3, b1 = cross(n1, u1);
  const R: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R.push(u1[i] * u[j] + n1[i] * n[j] + b1[i] * b[j]);
  const ph = stillPhase(st, 'pose');
  ph.pose = { sheet: po.sheet, from: [p[0], p[1], 0], to: [to[0], to[1], po.height ?? 0], R };
  return ph;
}

function stillPhase(st: State, motion: Phase['motion']): Phase {
  return makePhase(motion, st.faces.map((f) => ({ f, a: f.m, b: f.m, la: f.layer, lb: f.layer, d: 0 })));
}

/** Sets creases to 3D angles. The flat state does not change; the simulation bends the paper. */
function opShape(st: State, spec: NonNullable<StepSpec['shape']>): Phase {
  const list = Array.isArray(spec) ? spec : spec.creases ?? [];
  const fixed = Array.isArray(spec) ? undefined : spec.fixed;
  if (!list.length) throw new Error('shape needs at least one crease');
  if (fixed !== undefined) {
    const w = resolvePoint(st, fixed);
    const hit = st.faces.filter((f) => containsPoint(worldPoly(f), w, 1e-4));
    if (!hit.length) throw new Error('There is no paper at the "fixed" point');
    st.faces = st.faces.map((f) => ({ ...f, anchor: hit.includes(f) }));
  }
  const ph = stillPhase(st, 'shape');
  if (!Array.isArray(spec) && spec.soft) ph.soft = true;
  ph.shape = list.map((c) => {
    if (typeof c.angle !== 'number' || c.angle < 0 || c.angle > 180) throw new Error('shape: angle must be 0 to 180 degrees');
    if (c.creases) return { name: c.creases, angle: c.angle, ...(c.kind ? { kind: c.kind } : {}) };
    if (c.paper) {
      const [p, q] = fixList(c.paper).map((e) => resolvePaper(st, st.active, e));
      if (dist(p, q) < 1e-6) throw new Error('shape: the line needs two different points');
      return { p, q, paper: st.active, angle: c.angle, ...(c.kind ? { kind: c.kind } : {}) };
    }
    if (!c.line) throw new Error('shape: give "creases: <name>", "line: [P, Q]" or "paper: [P, Q]"');
    const [p, q] = fixList(c.line).map((e) => resolvePoint(st, e));
    if (dist(p, q) < 1e-6) throw new Error('shape: the line needs two different points');
    return { p, q, angle: c.angle, ...(c.kind ? { kind: c.kind } : {}) };
  });
  // Faces off the anchor move with the shaping (for placement weights).
  const anyAnchor = st.faces.some((f) => f.anchor);
  ph.faces.forEach((f) => (f.d = anyAnchor && !f.k ? 1 : 0));
  return ph;
}

/** Tips the whole model up about a base line, so it stands on the table. */
function opStand(st: State, spec: NonNullable<StepSpec['stand']>): Phase {
  const on = Array.isArray(spec) ? spec : spec.on;
  const angle = Array.isArray(spec) ? 90 : spec.angle ?? 90;
  let [p, q] = fixList(on).map((e) => resolvePoint(st, e));
  if (dist(p, q) < 1e-6) throw new Error('stand: the base line needs two different points');
  // Tip the side the model is on upwards: with the model on the left of p→q, a positive turn about p→q lifts it.
  const c = modelCenter(st);
  if (side(c, p, q) < 0) [p, q] = [q, p];
  const prev = st.tilt;
  const ph = stillPhase(st, 'stand');
  const a0 = prev ? prev.a : 0;
  const base = prev ?? { p, q, a: 0 };
  if (prev && (dist(prev.p, p) > 1e-6 || dist(prev.q, q) > 1e-6)) throw new Error('stand: the model is already standing on another line');
  st.tilt = { p: base.p, q: base.q, a: angle };
  ph.tilt = { p: base.p, q: base.q, a0, a1: angle };
  return ph;
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
  if (step.points) ops.unshift({ points: step.points } as unknown as Op);
  ops.push(...(step.ops ?? []));
  if (step.fold || step.crease || step.unfold || step.reverse) {
    const { fold, crease, unfold, reverse, line, move, layers, sheet, name } = step;
    ops.push({ fold, crease, unfold, reverse, line, move, layers, sheet, ...(name ? { name } : {}) });
  }
  if (step['turn-over']) ops.push({ 'turn-over': step['turn-over'] });
  if (step.rotate !== undefined) ops.push({ rotate: step.rotate });
  if (step.grid) ops.push({ grid: step.grid, sheet: step.sheet });
  if (step.collapse) ops.push({ collapse: step.collapse, sheet: step.sheet });
  if (step.refold) ops.push({ refold: step.refold, sheet: step.sheet, ...(step.name ? { name: step.name } : {}) });
  if (step.place) ops.push({ place: step.place });
  if (step.pose) ops.push({ pose: step.pose });
  if (step.pattern) ops.push({ pattern: step.pattern, sheet: step.sheet });
  if (step.shape) ops.push({ shape: step.shape });
  if (step.stand) ops.push({ stand: step.stand });
  return ops;
}

function defaultText(ops: Op[]): string {
  const op = ops.find((o) => !('mark' in o) && !('pin' in o) && !('points' in o));
  if (!op) return '';
  if ('turn-over' in op) return 'Turn the model over.';
  if ('rotate' in op) return `Rotate the model ${Math.abs(op.rotate)}°.`;
  if ('grid' in op) return `Crease a ${op.grid.n} × ${op.grid.m ?? op.grid.n} grid.`;
  if ('collapse' in op) return 'Collapse along the creases.';
  if ('refold' in op) return 'Fold along the creases and flatten.';
  if ('place' in op) return 'Put the pieces together.';
  if ('pose' in op) return 'Set the piece in place.';
  if ('shape' in op) return 'Open the model into shape.';
  if ('pattern' in op) return 'Crease the pattern.';
  if ('stand' in op) return 'Stand the model up.';
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

/** Sheets a step changes: faces that move, turn or crease. */
function stepSheets(phases: Phase[], placed: Set<string>): string[] {
  const out = new Set<string>();
  for (const ph of phases) {
    if (ph.motion === 'spin' || ph.motion === 'stand' || ph.motion === 'shape') continue;
    // Placing one sheet on another puts the model together: it is about every sheet.
    if (ph.motion === 'move') { for (const f of ph.faces) out.add(f.s); continue; }
    // Setting a piece in place in space is about that piece and the ones already standing there.
    if (ph.pose) { placed.add(ph.pose.sheet); for (const s of placed) out.add(s); continue; }
    for (const f of ph.faces) if (f.d !== 0 || f.a.some((v, i) => Math.abs(v - f.b[i]) > 1e-6)) out.add(f.s);
  }
  return [...out];
}

export function compileModel(script: ModelScript, bases: BaseLibrary = {}): CompiledModel {
  if (!script.materials?.length) throw new CompileError(-1, 'A model needs at least one sheet in "materials"');
  const st: State = { faces: [], pins: new Map(), sheets: new Map(), active: script.materials[0].id, nextId: 1, tilt: null };
  let x = 0;
  let layer = 0;
  const sheets: SheetInfo[] = [];
  const placed = new Set<string>();
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
      // Each phase carries the model's tilt as it is when the phase happens, so the viewer can pose it
      // standing (a shape before a stand in the same step is still lying down).
      const push = (...ps: Phase[]) => {
        for (const ph of ps) if (!ph.tilt && st.tilt) ph.tilt = { p: st.tilt.p, q: st.tilt.q, a0: st.tilt.a, a1: st.tilt.a };
        phases.push(...ps);
      };
      for (const op of ops) {
        if ('mark' in op) { opMark(st, op.mark); continue; }
        if ('points' in op) {
          const sh = st.sheets.get(st.active)!;
          for (const [k, e] of Object.entries((op as { points: Record<string, PointExpr> }).points)) sh.names.set(k, resolvePaper(st, st.active, e));
          continue;
        }
        if ('pin' in op) { for (const [k, e] of Object.entries((op as { pin: Record<string, PointExpr> }).pin)) st.pins.set(k, resolvePoint(st, e)); continue; }
        if ('turn-over' in op) { push(opTurnOver(st, op['turn-over'] === 'horizontal' ? 'horizontal' : 'vertical')); continue; }
        if ('rotate' in op) { push(opRotate(st, op.rotate)); continue; }
        if ('grid' in op) { push(opGrid(st, op.grid, op.sheet ?? st.active)); continue; }
        if ('collapse' in op) { push(opCollapse(st, op.collapse, op.sheet ?? st.active)); continue; }
        if ('refold' in op) { const ph = opRefold(st, op.refold, op.sheet ?? st.active); if (op.name) ph.name = op.name; push(ph); continue; }
        if ('place' in op) { push(opPlace(st, op.place)); continue; }
        if ('pose' in op) { push(opPose(st, op.pose)); continue; }
        if ('shape' in op) { push(opShape(st, op.shape)); continue; }
        if ('pattern' in op) { push(...opPattern(st, op.pattern, op.sheet ?? st.active)); continue; }
        if ('stand' in op) { push(opStand(st, op.stand)); continue; }
        const f = op as FoldOp;
        if (f.sheet) st.active = f.sheet;
        push(opFold(st, f));
      }
      cam = camera(step.camera, cam);
      if (!step.camera && (cam.auto || cam.preset === 'top')) cam = { ...cam, auto: true };
      else if (step.camera) cam = { ...cam, auto: false };
      steps.push({ text: step.text ?? defaultText(ops), tip: step.tip, group, sheets: stepSheets(phases, placed), camera: cam, phases });
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
