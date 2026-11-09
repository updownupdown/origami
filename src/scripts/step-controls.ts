import type { CompiledModel } from '../engine/types';
import type { FoldViewer } from './viewer';
import { stepSvg } from '../engine/svg';
import { runAt, sheetRuns, type SheetRun } from '../lib/sheets';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Each step plays once after landing on it; tapping the knob replays it. */
const SPEEDS = [1];
/** Narrowest a step may get on the bar before the bar scrolls sideways (px). */
const MIN_STEP = 22;
/** Gap between chapters on the bar (px). */
const GAP = 4;

/** A stretch of steps shown as one segment of the bar: a sheet, assembly, or a step group. */
export interface Chapter {
  start: number;
  end: number;
  label: string;
  /** Sheet id for a sheet run, null for assembly, undefined for a step group on a one-sheet model. */
  sheet?: string | null;
}

/** Multi-sheet models split by sheet; one-sheet models split by step group (if the author named any). */
export function chapters(model: CompiledModel, runs: SheetRun[] = sheetRuns(model)): Chapter[] {
  if (runs.length) return runs.map((r) => ({ start: r.start, end: r.end, label: r.label, sheet: r.sheet }));
  // Steps outside any base are labelled with the model's name ("Kite base", then "Whale").
  const named = model.steps.some((s) => s.group);
  const out: Chapter[] = [];
  model.steps.forEach((s, i) => {
    const label = s.group ?? (named ? model.title : '');
    const last = out[out.length - 1];
    if (!last || label !== last.label) out.push({ start: i, end: i, label });
    else last.end = i;
  });
  return out;
}

export interface StepControlsOptions {
  /** Called whenever the shown step changes. */
  onStep?: (i: number) => void;
  /** Called when the user settles on a step (buttons, keys, or letting go of the bar). */
  onLand?: (i: number) => void;
  /** Move the camera to each step's view (the model page does, the editor does not). */
  camera?: boolean;
}

/**
 * The step card shared by the model page and the editor: step text with chevrons beside it, and a
 * chapter bar across all steps. Dragging the bar shows a flat preview of the step under the finger
 * and leaves the 3D view alone; the view moves once, on release. Tapping the knob replays the step.
 */
export class StepControls {
  cur = 0;
  model: CompiledModel | null = null;
  viewer: FoldViewer | null = null;
  scrubbing = false;
  private reps = SPEEDS.length;
  private timer = 0;
  private opts: StepControlsOptions;
  private runs: SheetRun[] = [];
  private chs: Chapter[] = [];
  private stepW = 0;
  private t = 0;
  private previews = new Map<number, string>();
  private mapOpen = false;

  constructor(opts: StepControlsOptions = {}) {
    this.opts = opts;
    $('btn-prev').addEventListener('click', () => this.go(this.cur - 1));
    $('btn-next').addEventListener('click', () => this.go(this.cur + 1));
    $('step-where').addEventListener('click', () => this.toggleMap());
    $('amap-close').addEventListener('click', () => this.toggleMap(false));
    this.bindBar();
    new ResizeObserver(() => this.layout()).observe($('cbar-wrap'));
  }

  get count() { return this.model?.steps.length ?? 0; }

  /** Use a (new) model and viewer. The viewer's onFrame should call `frame`. */
  attach(model: CompiledModel, viewer: FoldViewer) {
    this.stopRepeats();
    this.model = model;
    this.viewer = viewer;
    this.previews.clear();
    this.runs = sheetRuns(model);
    this.chs = chapters(model, this.runs);
    $('cbar').setAttribute('aria-valuemax', String(this.count));
    this.renderSheets();
  }

  private color(id: string) {
    const m = this.model!;
    return this.viewer?.colors[id]?.front ?? m.sheets.find((s) => s.id === id)?.front ?? '#999';
  }

  /** CSS custom properties that colour a chapter: its paper, both papers for assembly, ink for step groups. */
  private chStyle(c: Chapter) {
    const m = this.model!;
    if (c.sheet) return `--c:${this.color(c.sheet)}`;
    if (c.sheet === null) return `--c1:${this.color(m.sheets[0].id)};--c2:${this.color(m.sheets[1].id)}`;
    return '--c:var(--ink)';
  }

  /** Builds the bar (and the map, if open). Call again when paper colours change. */
  renderSheets() {
    if (!this.model) return;
    const m = this.model;
    $('cbar-segs').innerHTML = this.chs.map((c, k) => {
      const kind = c.sheet ? ' paper' : c.sheet === null ? ' asm' : '';
      const n = c.end - c.start + 1;
      const steps = n === 1 ? `step ${c.start + 1}` : `steps ${c.start + 1} to ${c.end + 1}`;
      return `<div class="seg${kind}" data-k="${k}" style="${this.chStyle(c)}"><div class="fill"></div>${'<i></i>'.repeat(n)}</div>` +
        (c.label ? `<button class="lbl" data-k="${k}" tabindex="-1" title="${c.label}: ${steps}">${c.label}${c.sheet && (m.sheets.find((s) => s.id === c.sheet)?.count ?? 1) > 1 ? ` ×${m.sheets.find((s) => s.id === c.sheet)!.count}` : ''}</button>` : '');
    }).join('');
    this.layout();
    if (this.mapOpen) this.renderMap();
    if (this.count) this.label(this.cur);
  }

  /** Sizes the bar to the card, or wider (scrolling) when steps would get narrower than MIN_STEP. */
  private layout() {
    const N = this.count;
    if (!N) return;
    const wrap = $('cbar-wrap'), bar = $('cbar');
    const avail = wrap.clientWidth - 12;
    const gaps = GAP * (this.chs.length - 1);
    const pad = 16; // room for the knob at both ends
    this.stepW = Math.max(MIN_STEP, (avail - gaps - pad * 2) / N);
    const width = this.stepW * N + gaps + pad * 2;
    bar.style.width = `${Math.max(avail, width)}px`;
    wrap.classList.toggle('overflow', width > avail + 1);
    const ticks = this.stepW >= 9;
    bar.querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
      const c = this.chs[Number(seg.dataset.k)];
      seg.style.left = `${this.left(c.start)}px`;
      seg.style.width = `${(c.end - c.start + 1) * this.stepW}px`;
      seg.querySelectorAll<HTMLElement>('i').forEach((i, j) => { i.hidden = !ticks || j === 0; i.style.left = `${j * this.stepW}px`; });
    });
    bar.querySelectorAll<HTMLElement>('.lbl').forEach((l) => {
      const c = this.chs[Number(l.dataset.k)];
      l.style.left = `${this.left(c.start)}px`;
      l.style.maxWidth = `${Math.max(14, (c.end - c.start + 1) * this.stepW - 4)}px`;
    });
    this.place(this.cur, false);
    this.fill(this.cur, this.t);
    this.reveal(this.cur, false);
  }

  /** Left edge of step i's slot on the bar (px). */
  private left(i: number) {
    const k = this.chs.findIndex((c) => i >= c.start && i <= c.end);
    return 16 + i * this.stepW + GAP * (k < 0 ? this.chs.length - 1 : k);
  }
  private centre(i: number) { return i >= this.count ? this.left(this.count - 1) + this.stepW : this.left(i) + this.stepW / 2; }

  private stepAt(clientX: number) {
    const r = $('cbar').getBoundingClientRect(), x = clientX - r.left;
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.count; i++) { const d = Math.abs(this.centre(i) - x); if (d < bd) { bd = d; best = i; } }
    return best;
  }

  private place(i: number, drag: boolean) {
    const knob = $('cbar-knob');
    knob.style.left = `${this.centre(i)}px`;
    knob.querySelector('.num')!.textContent = i >= this.count ? '✓' : String(i + 1);
    if (!drag) $('cbar').querySelectorAll('.lbl').forEach((l) => { const c = this.chs[Number((l as HTMLElement).dataset.k)]; l.classList.toggle('now', i >= c.start && i <= c.end); });
  }

  /** Fills the bar up to step i, part way through its slot by t. */
  private fill(i: number, t: number) {
    $('cbar').querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
      const c = this.chs[Number(seg.dataset.k)], n = c.end - c.start + 1;
      const f = i > c.end ? 1 : i < c.start ? 0 : (i - c.start + t) / n;
      (seg.firstElementChild as HTMLElement).style.width = `${f * 100}%`;
    });
  }

  /** Scrolls a long bar so step i is in view. */
  private reveal(i: number, smooth = true) {
    const wrap = $('cbar-wrap'), x = this.centre(i);
    if (x < wrap.scrollLeft + 40 || x > wrap.scrollLeft + wrap.clientWidth - 40) {
      wrap.scrollTo({ left: x - wrap.clientWidth / 2, behavior: smooth ? 'smooth' : 'auto' });
    }
  }

  private preview(i: number) {
    let s = this.previews.get(i);
    if (s === undefined) {
      try { s = stepSvg(this.model!, i, { width: 104, height: 104, colors: this.viewer?.colors }); } catch { s = ''; }
      this.previews.set(i, s);
    }
    return s;
  }

  private showBubble(i: number) {
    const b = $('cbar-bubble'), wrap = $('cbar-wrap'), card = $('stepcard');
    const c = this.chs.find((ch) => i >= ch.start && i <= ch.end);
    b.querySelector('.pic')!.innerHTML = this.preview(i);
    b.querySelector('.cap')!.innerHTML = `Step ${i + 1}${c?.label ? `<small>${c.label}</small>` : ''}`;
    b.hidden = false;
    const x = wrap.offsetLeft + this.centre(i) - wrap.scrollLeft;
    b.style.left = `${Math.max(70, Math.min(card.clientWidth - 70, x))}px`;
    b.style.top = `${wrap.offsetTop - b.offsetHeight - 6}px`;
  }

  private bindBar() {
    const bar = $('cbar'), wrap = $('cbar-wrap');
    let id = -1, downX = 0, onKnob = false, moved = false, target = 0, lastX = 0, raf = 0;
    const edge = () => {
      // Drag near either end of a scrolling bar to keep going.
      const r = wrap.getBoundingClientRect();
      const d = lastX < r.left + 36 ? -1 : lastX > r.right - 36 ? 1 : 0;
      if (d && id >= 0) {
        wrap.scrollLeft += d * 8;
        target = this.stepAt(lastX);
        this.place(target, true);
        this.showBubble(target);
      }
      raf = id >= 0 ? requestAnimationFrame(edge) : 0;
    };
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.count) return;
      id = e.pointerId;
      bar.setPointerCapture(id);
      downX = lastX = e.clientX;
      onKnob = !!(e.target as HTMLElement).closest('.knob');
      moved = false;
      target = this.cur;
      e.preventDefault();
    });
    bar.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      lastX = e.clientX;
      if (!moved && Math.abs(e.clientX - downX) < 5) return;
      if (!moved) {
        moved = true;
        this.scrubbing = true;
        this.stopRepeats();
        bar.classList.add('drag');
        if (!raf) raf = requestAnimationFrame(edge);
      }
      target = this.stepAt(e.clientX);
      this.place(target, true);
      this.showBubble(target);
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      this.scrubbing = false;
      bar.classList.remove('drag');
      $('cbar-bubble').hidden = true;
      if (!moved) {
        const lbl = (e.target as HTMLElement).closest<HTMLElement>('.lbl');
        if (onKnob) { this.playRepeats(); return; }
        if (lbl) { this.go(this.chs[Number(lbl.dataset.k)].start); return; }
        target = this.stepAt(e.clientX);
      }
      if (e.type === 'pointercancel') { this.place(this.cur, false); return; }
      if (target === this.cur) { this.place(this.cur, false); this.viewer?.setT(0); this.playRepeats(); }
      else this.go(target);
    };
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { this.go(this.cur + 1); e.preventDefault(); e.stopPropagation(); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { this.go(this.cur - 1); e.preventDefault(); e.stopPropagation(); }
      if (e.key === 'Home') { this.go(0); e.preventDefault(); }
      if (e.key === 'End') { this.go(this.count); e.preventDefault(); }
      if (e.key === 'Enter' || e.key === ' ') { this.playRepeats(); e.preventDefault(); e.stopPropagation(); }
    });
  }

  /** Viewer frame callback: fills the current step's slot as it plays. */
  frame(t: number) {
    this.t = this.cur >= this.count ? 1 : t;
    if (!this.scrubbing) this.fill(this.cur, this.t);
  }

  private label(i: number) {
    const m = this.model!, N = this.count, finished = i >= N;
    const run = !finished && this.runs.length ? runAt(this.runs, i) : undefined;
    const where = $('step-where');
    where.hidden = !run;
    if (run) {
      const c = this.chs.find((ch) => ch.start === run.start)!;
      where.className = `where${run.sheet === null ? ' asm' : ''}`;
      where.setAttribute('style', this.chStyle(c));
      where.innerHTML = `<i></i>${run.label} ${i - run.start + 1}/${run.end - run.start + 1}`;
      where.setAttribute('aria-label', `${run.label}, step ${i - run.start + 1} of ${run.end - run.start + 1}. Show the map of parts.`);
      where.setAttribute('aria-expanded', String(this.mapOpen));
    }
    const group = !run && !finished ? m.steps[i].group : undefined;
    $('step-count').textContent = finished ? 'Finished' : `${group ? `${group} · ` : ''}Step ${i + 1} of ${N}`;
    $('step-text').textContent = finished ? m.finish.text : m.steps[i].text;

    // First step on a sheet: a card naming the sheet to pick up, in its paper colour.
    const sh = run && run.sheet && i === run.start ? m.sheets.find((s) => s.id === run.sheet) : undefined;
    const pick = $('step-pickup');
    pick.hidden = !sh;
    if (sh) {
      const size = sh.w === sh.h ? `${sh.w} cm square` : `${sh.w} × ${sh.h} cm`;
      const used = this.runs.some((r) => r.sheet === sh.id && r.start < i);
      $('pickup-swatch').style.setProperty('--c', this.color(sh.id));
      $('pickup-text').innerHTML = `<b>${used ? 'Back to' : i === 0 ? 'Start with' : 'New sheet'}: ${sh.name}${sh.count > 1 ? ` ×${sh.count}` : ''}</b> · ${size}`;
    }
    const tip = $('step-tip');
    const tipText = finished ? '' : m.steps[i].tip ?? '';
    tip.hidden = !tipText;
    tip.textContent = tipText;

    ($('btn-prev') as HTMLButtonElement).disabled = i === 0;
    ($('btn-next') as HTMLButtonElement).disabled = finished;
    const bar = $('cbar');
    bar.setAttribute('aria-valuenow', String(Math.min(i + 1, N)));
    bar.setAttribute('aria-valuetext', finished ? 'Finished' : `Step ${i + 1} of ${N}`);
    this.place(i, false);
    this.reveal(i);
    if (this.mapOpen) this.renderMap();
    this.opts.onStep?.(i);
  }

  // ---------- Map of parts ----------

  toggleMap(open = !this.mapOpen) {
    this.mapOpen = open && this.runs.length > 0;
    $('amap').hidden = !this.mapOpen;
    $('step-where').setAttribute('aria-expanded', String(this.mapOpen));
    if (this.mapOpen) {
      this.renderMap();
      const on = $('amap-scroll').querySelector<SVGGElement>('.st.on');
      if (on) { const x = Number(on.dataset.x); const s = $('amap-scroll'); s.scrollLeft = x - s.clientWidth / 2; }
    }
  }

  /**
   * Draws each sheet as a line of stops (one per step, in folding order), with assembly on its own
   * line in the middle. Lines join where a stretch of steps continues from another.
   */
  private renderMap() {
    const m = this.model!, N = this.count, runs = this.runs;
    const sheets = m.sheets.filter((s) => runs.some((r) => r.sheet === s.id));
    const hasAsm = runs.some((r) => r.sheet === null);
    const rowIds: (string | null)[] = sheets.map((s) => s.id);
    if (hasAsm) rowIds.splice(Math.ceil(rowIds.length / 2), 0, null);
    const COL = 26, ROW = 40, X0 = 14, Y0 = 34;
    const W = X0 * 2 + (N - 1) * COL + 70, H = Y0 + (rowIds.length - 1) * ROW + 16;
    const xy = (i: number): [number, number] => { const r = runAt(runs, i)!; return [X0 + i * COL, Y0 + rowIds.indexOf(r.sheet) * ROW]; };
    const stroke = (r: SheetRun) => (r.sheet ? this.color(r.sheet) : 'var(--ink-soft)');
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" aria-label="Map of parts">`;
    // Joins: each stretch continues from the latest unjoined stretch of its own sheet or of the assembly
    // before it; an assembly stretch also takes in every sheet that has not joined yet.
    const joined = new Set<number>();
    runs.forEach((r, k) => {
      const from: number[] = [];
      const latest = (pred: (x: SheetRun) => boolean) => { for (let j = k - 1; j >= 0; j--) if (pred(runs[j])) return j; return -1; };
      if (r.sheet === null) {
        for (const s of rowIds) { const j = latest((x) => x.sheet === s); if (j >= 0 && !joined.has(j)) from.push(j); }
      } else {
        const j = Math.max(latest((x) => x.sheet === r.sheet), latest((x) => x.sheet === null));
        if (j >= 0 && !joined.has(j)) from.push(j);
      }
      for (const j of from) {
        joined.add(j);
        const [x1, y1] = xy(runs[j].end), [x2, y2] = xy(r.start), mx = (x1 + x2) / 2;
        svg += `<path d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none" stroke="${stroke(runs[j])}" stroke-width="4" opacity=".55"/>`;
      }
    });
    runs.forEach((r) => {
      const [x1, y] = xy(r.start), [x2] = xy(r.end);
      if (x2 > x1) svg += `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${stroke(r)}" stroke-width="4" opacity=".55"/>`;
    });
    rowIds.forEach((s, k) => {
      const first = runs.find((r) => r.sheet === s)!;
      const sh = s ? m.sheets.find((x) => x.id === s) : undefined;
      svg += `<text x="${Math.max(2, xy(first.start)[0] - 8)}" y="${Y0 + k * ROW - 15}" font-size="11" font-weight="600" fill="var(--ink-soft)">${first.label}${sh && sh.count > 1 ? ` ×${sh.count}` : ''}</text>`;
    });
    for (let i = 0; i < N; i++) {
      const [x, y] = xy(i), r = runAt(runs, i)!, on = i === this.cur, done = i < this.cur;
      const fill = on ? 'var(--ink)' : done ? stroke(r) : 'var(--paper-raised)';
      svg += `<g class="st${on ? ' on' : ''}" data-i="${i}" data-x="${x}" tabindex="0" role="button" aria-label="Step ${i + 1}, ${r.label}"><circle cx="${x}" cy="${y}" r="${on ? 11 : 9}" fill="${fill}" stroke="${on ? 'var(--ink)' : stroke(r)}" stroke-width="2.5"/>` +
        `<text x="${x}" y="${y + 3.5}" text-anchor="middle" font-size="9.5" font-weight="600" fill="${on || done ? 'var(--paper-raised)' : 'var(--ink)'}" pointer-events="none">${i + 1}</text></g>`;
    }
    svg += '</svg>';
    const box = $('amap-scroll'), keep = box.scrollLeft;
    box.innerHTML = svg;
    box.scrollLeft = keep;
    box.querySelectorAll<SVGGElement>('.st').forEach((g) => {
      g.addEventListener('click', () => this.go(Number(g.dataset.i)));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.go(Number(g.dataset.i)); } });
    });
  }

  // ---------- Playback ----------

  stopRepeats() {
    this.reps = SPEEDS.length;
    clearTimeout(this.timer);
    if (this.viewer) this.viewer.opts.onEnd = undefined;
  }

  /** Plays the current step three times, slower each time. */
  playRepeats() {
    const v = this.viewer;
    this.stopRepeats();
    if (!v || this.cur >= this.count) return;
    this.reps = 0;
    v.opts.onEnd = () => {
      this.reps++;
      if (this.reps >= SPEEDS.length) return;
      this.timer = window.setTimeout(() => { if (this.reps < SPEEDS.length) v.play(SPEEDS[this.reps]); }, 700);
    };
    v.play(SPEEDS[0]);
  }

  /** Shows step i (count = finished model). */
  show(i: number, play = true) {
    if (!this.viewer) return;
    this.stopRepeats();
    this.cur = Math.max(0, Math.min(this.count, i));
    this.viewer.showStep(this.cur, { play: false, camera: this.opts.camera ?? true });
    this.label(this.cur);
    this.frame(this.viewer.t);
    this.opts.onLand?.(this.cur);
    if (play) this.playRepeats();
  }

  go(i: number) { this.show(i); }
}
