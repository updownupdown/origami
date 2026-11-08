import type { CompiledModel } from '../engine/types';
import type { FoldViewer } from './viewer';
import { runAt, sheetRuns, type SheetRun } from '../lib/sheets';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Speeds for the three plays of a step after landing on it: each slower than the last. */
const SPEEDS = [1, 0.7, 0.5];

/**
 * A slider whose knob is also a button: drag anywhere to set the value, tap the knob to "press" it.
 * Values run 0..1. Keyboard: arrows step, Enter or Space presses.
 */
class KnobSlider {
  value = 0;
  dragging = false;
  private knob: HTMLElement;
  private fill: HTMLElement;
  constructor(public el: HTMLElement, private h: { input: (v: number) => void; release: (v: number) => void; tap: () => void; step?: () => number }) {
    this.knob = el.querySelector('.knob')!;
    this.fill = el.querySelector('.fill')!;
    let downX = 0, onKnob = false, moved = false, id = -1;
    const valAt = (x: number) => {
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width)));
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      id = e.pointerId;
      el.setPointerCapture(id);
      downX = e.clientX;
      onKnob = !!(e.target as HTMLElement).closest('.knob');
      moved = false;
      if (!onKnob) { this.dragging = true; this.set(valAt(e.clientX)); h.input(this.value); }
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      if (!moved && Math.abs(e.clientX - downX) < 5 && onKnob) return;
      moved = true;
      this.dragging = true;
      this.set(valAt(e.clientX));
      h.input(this.value);
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      const wasDrag = this.dragging;
      this.dragging = false;
      if (onKnob && !moved) { h.tap(); return; }
      if (wasDrag) h.release(this.value);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    this.knob.addEventListener('keydown', (e) => {
      const st = h.step?.() ?? 0.05;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { this.set(this.value + st); h.input(this.value); h.release(this.value); e.preventDefault(); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { this.set(this.value - st); h.input(this.value); h.release(this.value); e.preventDefault(); }
      if (e.key === 'Enter' || e.key === ' ') { h.tap(); e.preventDefault(); }
    });
  }
  set(v: number) {
    this.value = Math.max(0, Math.min(1, v));
    const pc = `${this.value * 100}%`;
    this.knob.style.left = pc;
    this.fill.style.width = pc;
    this.knob.setAttribute('aria-valuenow', String(Math.round(this.value * 100)));
  }
}

export interface StepControlsOptions {
  /** Called whenever the shown step changes (also while dragging). */
  onStep?: (i: number) => void;
  /** Called when the user settles on a step (buttons, keys, or letting go of the bar). */
  onLand?: (i: number) => void;
  /** Move the camera to each step's view (the model page does, the editor does not). */
  camera?: boolean;
}

/**
 * The step card shared by the model page and the editor: chevrons, a slider for this step (its knob
 * replays the step when tapped), and a slider across all steps (its knob shows the step number).
 */
export class StepControls {
  cur = 0;
  model: CompiledModel | null = null;
  viewer: FoldViewer | null = null;
  private reps = SPEEDS.length;
  private timer = 0;
  private opts: StepControlsOptions;
  private one: KnobSlider;
  private all: KnobSlider;
  private runs: SheetRun[] = [];

  constructor(opts: StepControlsOptions = {}) {
    this.opts = opts;
    $('btn-prev').addEventListener('click', () => this.go(this.cur - 1));
    $('btn-next').addEventListener('click', () => this.go(this.cur + 1));
    this.one = new KnobSlider($('sl-step'), {
      input: (v) => { this.stopRepeats(); this.viewer?.setT(v); },
      release: () => {},
      tap: () => this.playRepeats(),
      step: () => 0.05,
    });
    this.all = new KnobSlider($('sl-all'), {
      input: (v) => this.onDrag(v),
      release: (v) => this.onRelease(v),
      tap: () => this.playRepeats(),
      step: () => 1 / Math.max(1, this.count),
    });
  }

  get count() { return this.model?.steps.length ?? 0; }
  get scrubbing() { return this.one.dragging || this.all.dragging; }

  /** Use a (new) model and viewer. The viewer's onFrame should call `frame`. */
  attach(model: CompiledModel, viewer: FoldViewer) {
    this.stopRepeats();
    this.model = model;
    this.viewer = viewer;
    const N = this.count;
    $('sl-all').querySelector('.ticks')!.innerHTML = model.steps.slice(1).map((_, i) => `<i style="left:${((i + 1) / N) * 100}%"></i>`).join('');
    this.runs = sheetRuns(model);
    this.renderSheets();
  }

  /** Draws the sheet runs under the all-steps bar (multi-sheet models only). Call again when colours change. */
  renderSheets() {
    const bar = $('sheet-bar'), m = this.model;
    bar.hidden = !this.runs.length;
    if (!m || !this.runs.length) { bar.innerHTML = ''; return; }
    const N = this.count;
    const col = (id: string) => this.viewer?.colors[id]?.front ?? m.sheets.find((s) => s.id === id)?.front ?? '#999';
    bar.innerHTML = this.runs.map((r, k) => {
      const left = (r.start / N) * 100, width = ((r.end - r.start + 1) / N) * 100;
      const style = r.sheet ? `--run:${col(r.sheet)}` : `--c1:${col(m.sheets[0].id)};--c2:${col(m.sheets[1].id)}`;
      const steps = r.start === r.end ? `step ${r.start + 1}` : `steps ${r.start + 1} to ${r.end + 1}`;
      return `<button class="run${r.sheet ? '' : ' asm'}" data-k="${k}" style="left:${left}%;width:${width}%;${style}" title="${r.label}: ${steps}" aria-label="${r.label}, ${steps}"><i></i><span>${r.label}</span></button>`;
    }).join('');
    bar.querySelectorAll<HTMLButtonElement>('.run').forEach((b) => b.addEventListener('click', () => this.go(this.runs[Number(b.dataset.k)].start)));
    this.markRun(this.cur);
  }

  private markRun(i: number) {
    if (!this.runs.length) return;
    const r = runAt(this.runs, i);
    $('sheet-bar').querySelectorAll('.run').forEach((b, k) => b.classList.toggle('now', this.runs[k] === r && i < this.count));
  }

  /** Viewer frame callback: keeps both sliders in step with the animation. */
  frame(t: number) {
    if (!this.one.dragging) this.one.set(this.cur >= this.count ? 1 : t);
    if (!this.all.dragging) this.all.set(this.count ? Math.min(1, (this.cur + (this.cur >= this.count ? 0 : t)) / this.count) : 1);
  }

  private label(i: number) {
    const m = this.model!, N = this.count, finished = i >= N;
    // Multi-sheet models name the sheet (or "Assemble") and count steps within it as well as overall.
    const run = !finished && this.runs.length ? runAt(this.runs, i) : undefined;
    const where = run ? `${run.label} ${i - run.start + 1}/${run.end - run.start + 1} · ` : '';
    $('step-label').textContent = finished ? 'Finished' : `${where}${m.steps[i].group ? `${m.steps[i].group} · ` : ''}Step ${i + 1} of ${N}`;
    this.markRun(i);
    $('step-text').textContent = finished ? m.finish.text : m.steps[i].text;
    const tip = $('step-tip');
    // First step on a new sheet: say which sheet to pick up.
    const sh = run && run.sheet && i === run.start && i > 0 ? m.sheets.find((s) => s.id === run.sheet) : undefined;
    const pick = sh ? `New sheet: ${sh.name}, ${sh.w === sh.h ? `${sh.w} cm square` : `${sh.w} × ${sh.h} cm`}.` : '';
    const tipText = finished ? '' : [pick, m.steps[i].tip ?? ''].filter(Boolean).join(' ');
    tip.hidden = !tipText;
    tip.textContent = tipText;
    ($('btn-prev') as HTMLButtonElement).disabled = i === 0;
    ($('btn-next') as HTMLButtonElement).disabled = finished;
    const seg = $('sl-all').querySelector<HTMLElement>('.seg')!;
    seg.style.left = `${(Math.min(i, N - 1) / Math.max(1, N)) * 100}%`;
    seg.style.width = finished ? '0' : `${100 / Math.max(1, N)}%`;
    $('sl-all').querySelector('.num')!.textContent = finished ? '✓' : String(i + 1);
    $('sl-all').querySelector('.knob')!.setAttribute('aria-valuetext', finished ? 'Finished' : `Step ${i + 1} of ${N}`);
    $('sl-step').hidden = finished;
    this.opts.onStep?.(i);
  }

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

  private onDrag(f: number) {
    const v = this.viewer;
    if (!v) return;
    this.stopRepeats();
    const N = this.count, x = f * N;
    const i = Math.min(N, Math.floor(x)), t = i >= N ? 1 : x - i;
    if (i !== this.cur || v.step !== i) { this.cur = i; v.showStep(i, { play: false, camera: false }); this.label(i); }
    v.setT(t);
    this.one.set(t);
  }

  private onRelease(f: number) {
    const N = this.count, x = f * N;
    const i = Math.min(N, Math.floor(x));
    this.opts.onLand?.(i);
    // Landing inside a step replays it; a bar left at a step's very end stays there.
    if (i < N && x - i < 0.995) { this.viewer?.setT(0); this.frame(0); this.playRepeats(); }
  }
}
