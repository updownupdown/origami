// Flat top-down SVG rendering of a folded state. Used for step thumbnails, the
// crease-pattern view, print, and a no-WebGL fallback.

import { type Mat, type V2, apply, bbox, det } from './geometry.ts';
import type { CompiledModel, DiagramArrow, DiagramLine, PhaseFace, SheetInfo } from './types.ts';

export interface SvgOptions {
  width?: number;
  height?: number;
  colors?: Record<string, { front: string; back: string }>;
  lines?: DiagramLine[];
  arrows?: DiagramArrow[];
  padding?: number;
  background?: string;
  stroke?: string;
  /** Use the "a" (before) transforms instead of "b" (after). */
  before?: boolean;
}

const unflat = (p: number[]): V2[] => {
  const out: V2[] = [];
  for (let i = 0; i < p.length; i += 2) out.push([p[i], p[i + 1]]);
  return out;
};

export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c * k)));
  return `#${((1 << 24) | (f(r) << 16) | (f(g) << 8) | f(b)).toString(16).slice(1)}`;
}

export function facesToSvg(faces: PhaseFace[], sheets: SheetInfo[], opt: SvgOptions = {}): string {
  const W = opt.width ?? 240, H = opt.height ?? 240, pad = opt.padding ?? 0.08;
  const colors = opt.colors ?? {};
  const polys = faces.map((f) => {
    const m: Mat = opt.before ? f.a : f.b;
    return { f, m, layer: opt.before ? f.la : f.lb, pts: unflat(f.p).map((p) => apply(m, p)) };
  });
  const extra: V2[] = [];
  for (const l of opt.lines ?? []) extra.push(l.p, l.q);
  for (const a of opt.arrows ?? []) extra.push(a.from, a.to);
  const b = bbox([...polys.flatMap((x) => x.pts), ...extra]);
  const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) || 1;
  const scale = (Math.min(W, H) * (1 - 2 * pad)) / span;
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
  const tx = (p: V2): string => `${(W / 2 + (p[0] - cx) * scale).toFixed(2)},${(H / 2 - (p[1] - cy) * scale).toFixed(2)}`;
  const sheetMap = new Map(sheets.map((s) => [s.id, s]));
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`);
  if (opt.background) out.push(`<rect width="${W}" height="${H}" fill="${opt.background}"/>`);
  polys.sort((x, y) => x.layer - y.layer);
  for (const x of polys) {
    const sh = sheetMap.get(x.f.s);
    const c = colors[x.f.s] ?? { front: sh?.front ?? '#e8642c', back: sh?.back ?? '#fbf7ee' };
    const up = det(x.m) > 0;
    const fill = up ? c.front : c.back;
    out.push(`<polygon points="${x.pts.map(tx).join(' ')}" fill="${fill}" stroke="${opt.stroke ?? shade(fill, 0.72)}" stroke-width="0.8" stroke-linejoin="round"/>`);
  }
  for (const l of opt.lines ?? []) {
    const dash = l.kind === 'mountain' ? '7 3 1.5 3' : '6 4';
    const col = l.kind === 'mountain' ? '#c4540a' : '#2f6fdb';
    out.push(`<line x1="${tx(l.p).split(',')[0]}" y1="${tx(l.p).split(',')[1]}" x2="${tx(l.q).split(',')[0]}" y2="${tx(l.q).split(',')[1]}" stroke="${col}" stroke-width="2" stroke-dasharray="${dash}"/>`);
  }
  for (const a of opt.arrows ?? []) {
    const [x1, y1] = tx(a.from).split(',').map(Number), [x2, y2] = tx(a.to).split(',').map(Number);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const dx = x2 - x1, dy = y2 - y1;
    const bend = 0.35;
    const qx = mx - dy * bend, qy = my + dx * bend;
    out.push(`<path d="M${x1},${y1} Q${qx},${qy} ${x2},${y2}" fill="none" stroke="#2b2a28" stroke-width="1.6"/>`);
    const ang = Math.atan2(y2 - qy, x2 - qx);
    const h = 7;
    const p1 = `${x2 - h * Math.cos(ang - 0.4)},${y2 - h * Math.sin(ang - 0.4)}`;
    const p2 = `${x2 - h * Math.cos(ang + 0.4)},${y2 - h * Math.sin(ang + 0.4)}`;
    out.push(`<polygon points="${x2},${y2} ${p1} ${p2}" fill="#2b2a28"/>`);
  }
  out.push('</svg>');
  return out.join('');
}

/** SVG of each step: the paper before the fold, with its fold lines and arrows. */
export function stepSvg(model: CompiledModel, i: number, opt: SvgOptions = {}): string {
  const step = model.steps[i];
  if (step.phases.length) {
    const ph = step.phases[0];
    return facesToSvg(ph.faces, model.sheets, { ...opt, before: true, lines: ph.lines, arrows: ph.arrows });
  }
  return facesToSvg(stateBefore(model, i), model.sheets, { ...opt, before: false });
}

export function stateBefore(model: CompiledModel, i: number): PhaseFace[] {
  for (let k = i - 1; k >= 0; k--) {
    const ph = model.steps[k].phases;
    if (ph.length) return ph[ph.length - 1].faces;
  }
  for (const s of model.steps) if (s.phases.length) return s.phases[0].faces.map((f) => ({ ...f, b: f.a, lb: f.la }));
  return [];
}

/** SVG of the final model. */
export function finalSvg(model: CompiledModel, opt: SvgOptions = {}): string {
  return facesToSvg(stateBefore(model, model.steps.length), model.sheets, opt);
}

/** Crease pattern: every face edge drawn on the unfolded sheet, coloured by fold direction. */
export function creasePatternSvg(model: CompiledModel, sheetId: string, opt: { size?: number } = {}): string {
  const faces = stateBefore(model, model.steps.length).filter((f) => f.s === sheetId);
  const sheet = model.sheets.find((s) => s.id === sheetId)!;
  const S = opt.size ?? 320, pad = 12;
  const scale = (S - 2 * pad) / Math.max(sheet.w, sheet.h);
  const tx = (p: V2) => [pad + p[0] * scale, S - pad - p[1] * scale];
  const edges = new Map<string, { a: V2; b: V2; faces: PhaseFace[] }>();
  const key = (p: V2) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  for (const f of faces) {
    const pts = unflat(f.p);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const k = [key(a), key(b)].sort().join('|');
      const e = edges.get(k) ?? { a, b, faces: [] };
      e.faces.push(f);
      edges.set(k, e);
    }
  }
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">`];
  out.push(`<rect x="${pad}" y="${S - pad - sheet.h * scale}" width="${sheet.w * scale}" height="${sheet.h * scale}" fill="#fffdf9" stroke="#2b2a28" stroke-width="1.5"/>`);
  for (const e of edges.values()) {
    if (e.faces.length < 2) continue;
    const [f, g] = e.faces;
    const same = f.b.every((v, i) => Math.abs(v - g.b[i]) < 1e-4);
    const [x1, y1] = tx(e.a), [x2, y2] = tx(e.b);
    if (same) {
      out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#bdb5a6" stroke-width="0.8"/>`);
      continue;
    }
    const valley = (det(f.b) > 0) === (g.lb > f.lb);
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${valley ? '#2f6fdb' : '#c4540a'}" stroke-width="1.6" stroke-dasharray="${valley ? '6 4' : '7 3 1.5 3'}"/>`);
  }
  out.push('</svg>');
  return out.join('');
}
