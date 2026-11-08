import type { CompiledModel } from '../engine/types';
import type { FoldViewer } from './viewer';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Speeds for the three plays of a step after landing on it: each slower than the last. */
const SPEEDS = [1, 0.7, 0.5];

export interface StepControlsOptions {
  /** Called whenever the shown step changes (also while dragging). */
  onStep?: (i: number) => void;
  /** Called when the user settles on a step (buttons, keys, or letting go of the bar). */
  onLand?: (i: number) => void;
  /** Move the camera to each step's preset (the model page does, the editor does not). */
  camera?: boolean;
}

/** The step card shared by the model page and the editor: chevrons, replay, and one bar across all steps. */
export class StepControls {
  cur = 0;
  scrubbing = false;
  model: CompiledModel | null = null;
  viewer: FoldViewer | null = null;
  private reps = SPEEDS.length;
  private timer = 0;
  private scrub = $<HTMLInputElement>('scrub');
  private opts: StepControlsOptions;

  constructor(opts: StepControlsOptions = {}) {
    this.opts = opts;
    $('btn-prev').addEventListener('click', () => this.go(this.cur - 1));
    $('btn-next').addEventListener('click', () => this.go(this.cur + 1));
    $('btn-play').addEventListener('click', () => this.playRepeats());
    this.scrub.addEventListener('input', () => this.onDrag());
    this.scrub.addEventListener('change', () => this.onRelease());
  }

  get count() { return this.model?.steps.length ?? 0; }

  /** Use a (new) model and viewer. The viewer's onFrame should call `frame`. */
  attach(model: CompiledModel, viewer: FoldViewer) {
    this.stopRepeats();
    this.model = model;
    this.viewer = viewer;
    const N = this.count;
    this.scrub.max = String(Math.max(1, N) * 1000);
    $('ticks').innerHTML = model.steps.slice(1).map((_, i) => `<i style="left:${((i + 1) / N) * 100}%"></i>`).join('');
  }

  /** Viewer frame callback: keeps the bar in step with the animation. */
  frame(t: number) { if (!this.scrubbing) this.setBar(this.cur + t); }

  private setBar(v: number) {
    const N = this.count;
    const f = N ? Math.max(0, Math.min(1, v / N)) : 1;
    this.scrub.value = String(Math.round(v * 1000));
    $('fill').style.width = `${f * 100}%`;
    $('track').style.setProperty('--knob', `${f * 100}%`);
  }

  private label(i: number) {
    const m = this.model!, N = this.count, finished = i >= N;
    $('step-label').textContent = finished ? 'Finished' : `${m.steps[i].group ? `${m.steps[i].group} · ` : ''}Step ${i + 1} of ${N}`;
    $('step-text').textContent = finished ? m.finish.text : m.steps[i].text;
    const tip = $('step-tip');
    tip.hidden = finished || !m.steps[i].tip;
    tip.textContent = finished ? '' : m.steps[i].tip ?? '';
    ($('btn-prev') as HTMLButtonElement).disabled = i === 0;
    ($('btn-next') as HTMLButtonElement).disabled = finished;
    const seg = $('seg');
    seg.style.left = `${(Math.min(i, N - 1) / Math.max(1, N)) * 100}%`;
    seg.style.width = finished ? '0' : `${100 / Math.max(1, N)}%`;
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
    this.setBar(this.cur);
    this.opts.onLand?.(this.cur);
    if (play) this.playRepeats();
  }

  go(i: number) { this.show(i); }

  private onDrag() {
    const v = this.viewer;
    if (!v) return;
    if (!this.scrubbing) { this.scrubbing = true; this.stopRepeats(); }
    const N = this.count, x = Number(this.scrub.value) / 1000;
    const i = Math.min(N, Math.floor(x)), t = i >= N ? 1 : x - i;
    if (i !== this.cur || v.step !== i) { this.cur = i; v.showStep(i, { play: false, camera: false }); this.label(i); }
    v.setT(t);
    this.setBar(x);
  }

  private onRelease() {
    this.scrubbing = false;
    const N = this.count, x = Number(this.scrub.value) / 1000;
    const i = Math.min(N, Math.floor(x));
    this.opts.onLand?.(i);
    // Landing inside a step replays it; a bar left at a step's very end stays there.
    if (i < N && x - i < 0.995) { this.viewer?.setT(0); this.setBar(i); this.playRepeats(); }
  }
}
