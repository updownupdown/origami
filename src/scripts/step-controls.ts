import type { CompiledModel } from '../engine/types';
import type { FoldViewer } from './viewer';
import { runAt, sheetRuns, type SheetRun } from '../lib/sheets';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Each step plays once after landing on it; the replay button plays it again. */
const SPEEDS = [1];

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
 * replay button and a progress bar for the current step that fills as the step plays. Drag the bar to
 * scrub through the step. Replaying, or going back a step, first plays the fold backwards so the paper
 * unfolds instead of jumping. Chevrons, arrow keys and the steps panel move between steps.
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
  private t = 0;
  private mapOpen = false;

  constructor(opts: StepControlsOptions = {}) {
    this.opts = opts;
    $('btn-prev').addEventListener('click', () => this.go(this.cur - 1));
    $('btn-next').addEventListener('click', () => this.go(this.cur + 1));
    $('btn-replay').addEventListener('click', () => this.playRepeats());
    $('step-where').addEventListener('click', () => this.toggleMap());
    $('amap-close').addEventListener('click', () => this.toggleMap(false));
    this.bindBar();
  }

  get count() { return this.model?.steps.length ?? 0; }

  /** Use a (new) model and viewer. The viewer's onFrame should call `frame`. */
  attach(model: CompiledModel, viewer: FoldViewer) {
    this.stopRepeats();
    this.model = model;
    this.viewer = viewer;
    this.runs = sheetRuns(model);
    this.renderSheets();
  }

  private color(id: string) {
    const m = this.model!;
    return this.viewer?.colors[id]?.front ?? m.sheets.find((s) => s.id === id)?.front ?? '#999';
  }

  /** CSS custom properties that colour a sheet run: its paper, or both papers for assembly. */
  private runStyle(r: SheetRun) {
    const m = this.model!;
    if (r.sheet) return `--c:${this.color(r.sheet)}`;
    return `--c1:${this.color(m.sheets[0].id)};--c2:${this.color(m.sheets[1].id)}`;
  }

  /** Recolours the bar and the sheet chip (and the map, if open). Call again when paper colours change. */
  renderSheets() {
    if (!this.model) return;
    if (this.mapOpen) this.renderMap();
    if (this.count) this.label(this.cur);
  }

  /** Moves the fill and knob to t (0..1) of the current step. */
  private set(t: number) {
    const pc = `${Math.max(0, Math.min(1, t)) * 100}%`;
    $('pbar-fill').style.width = pc;
    $('pbar-knob').style.left = pc;
    $('pbar').setAttribute('aria-valuenow', String(Math.round(t * 100)));
  }

  private bindBar() {
    const bar = $('pbar'), track = $('pbar-track');
    let id = -1;
    const tAt = (x: number) => {
      const r = track.getBoundingClientRect();
      return Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width)));
    };
    const scrub = (x: number) => {
      if (!this.scrubbing) { this.scrubbing = true; this.stopRepeats(); bar.classList.add('drag'); }
      const t = tAt(x);
      this.viewer?.setT(t);
      this.set(t);
    };
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.count || this.cur >= this.count) return;
      id = e.pointerId;
      bar.setPointerCapture(id);
      scrub(e.clientX);
      e.preventDefault();
    });
    bar.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      scrub(e.clientX);
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      this.scrubbing = false;
      bar.classList.remove('drag');
    };
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
    bar.addEventListener('keydown', (e) => {
      const nudge = (d: number) => { this.stopRepeats(); const t = Math.max(0, Math.min(1, (this.viewer?.t ?? 0) + d)); this.viewer?.setT(t); this.set(t); };
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') nudge(0.1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') nudge(-0.1);
      else if (e.key === 'Home') nudge(-1);
      else if (e.key === 'End') nudge(1);
      else if (e.key === 'Enter' || e.key === ' ') this.playRepeats();
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  /** Viewer frame callback: fills the bar as the current step plays. */
  frame(t: number) {
    this.t = this.cur >= this.count ? 1 : t;
    if (!this.scrubbing) this.set(this.t);
  }

  private label(i: number) {
    const m = this.model!, N = this.count, finished = i >= N;
    const run = !finished && this.runs.length ? runAt(this.runs, i) : undefined;
    const where = $('step-where');
    where.hidden = !run;
    if (run) {
      where.className = `where${run.sheet === null ? ' asm' : ''}`;
      where.setAttribute('style', this.runStyle(run));
      where.innerHTML = `<i></i>${run.label} ${i - run.start + 1}/${run.end - run.start + 1}`;
      where.setAttribute('aria-label', `${run.label}, step ${i - run.start + 1} of ${run.end - run.start + 1}. Show the map of parts.`);
      where.setAttribute('aria-expanded', String(this.mapOpen));
    }
    const group = !finished ? m.steps[i].group : undefined;
    $('step-count').textContent = finished ? 'Finished' : `${group && !run ? `${group} · ` : ''}Step ${i + 1} of ${N}`;
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

    // The bar takes the colour of the sheet being folded (ink on one-sheet models).
    const bar = $('pbar');
    $('prow').hidden = finished;
    bar.className = `pbar${run?.sheet === null ? ' asm' : run ? ' paper' : ''}`;
    bar.setAttribute('style', run ? this.runStyle(run) : '');
    bar.setAttribute('aria-valuetext', finished ? 'Finished' : `Step ${i + 1} of ${N}`);
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
    if (this.viewer?.rewinding) this.viewer.stop();
    if (this.viewer) this.viewer.opts.onEnd = undefined;
  }

  /** Plays the current step (once per entry in SPEEDS). */
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
    // Unfold back to the start of the step first, then fold it again.
    const step = this.cur;
    v.rewind(() => { if (this.cur === step && this.reps === 0) v.play(SPEEDS[0]); });
  }

  /** Shows step i (count = finished model). */
  show(i: number, play = true) {
    if (!this.viewer) return;
    this.stopRepeats();
    const back = i < this.cur;
    this.cur = Math.max(0, Math.min(this.count, i));
    this.viewer.showStep(this.cur, { play: false, camera: this.opts.camera ?? true });
    // Going back: start from where the paper is now (the end of this step) and unfold it.
    if (back && play && this.cur < this.count) this.viewer.setT(1);
    this.label(this.cur);
    this.frame(this.viewer.t);
    this.opts.onLand?.(this.cur);
    if (play) this.playRepeats();
  }

  go(i: number) { this.show(i); }
}
