import { parse } from 'yaml';
import { compileModel, type BaseLibrary } from '../engine/compile';
import type { CompiledModel, ModelScript } from '../engine/types';
import { FoldViewer } from './viewer';
import { StepControls } from './step-controls';

const base = (window as any).__BASE__ as string;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const DRAFT = 'origami:author:draft';

const BLANK = `id: my-model
title: My model
categories: [animals/mammals]
difficulty: 1
description: A short description.
credits:
  designer: Your name
  script: Your name
materials:
  - id: paper
    size: 15
    diamond: true
    colors: { front: "#e8642c", back: "#fbf7ee" }
steps:
  - text: Fold the top corner down to the bottom corner.
    fold: valley
    line: [B, D]
    move: A
  - text: Fold the right corner up.
    fold: valley
    line: [lerp(O B 0.6), C]
    move: B
`;

export async function initAuthor() {
  const src = $<HTMLTextAreaElement>('src');
  const status = $('status');
  const params = new URLSearchParams(location.search);
  const bases: BaseLibrary = await fetch(`${base}bases.json`).then((r) => r.json()).catch(() => ({}));

  let viewer: FoldViewer | null = null;
  let finalView: FoldViewer | null = null;
  let model: CompiledModel | null = null;
  let finalTimer = 0;
  const steps = new StepControls({ camera: false });

  // Colour override, so dark or similar paper colours can be swapped while writing.
  const COLORS = 'origami:author:colors';
  let override: { front: string; back: string } | null = null;
  try { override = JSON.parse(localStorage.getItem(COLORS) || 'null'); } catch { /* ignore */ }
  const colorsFor = (m: CompiledModel) => Object.fromEntries(m.sheets.map((s) => [s.id, override ?? { front: s.front, back: s.back }]));
  const syncInputs = () => {
    const s = model?.sheets[0];
    $<HTMLInputElement>('col-front').value = override?.front ?? s?.front ?? '#e8642c';
    $<HTMLInputElement>('col-back').value = override?.back ?? s?.back ?? '#fbf7ee';
  };
  const applyColors = () => {
    try { localStorage.setItem(COLORS, JSON.stringify(override)); } catch { /* ignore */ }
    if (model) { viewer?.setColors(colorsFor(model)); finalView?.setColors(colorsFor(model)); }
    syncInputs();
  };
  for (const side of ['front', 'back'] as const) {
    $<HTMLInputElement>(`col-${side}`).addEventListener('input', (e) => {
      const s = model?.sheets[0];
      override = { front: override?.front ?? s?.front ?? '#e8642c', back: override?.back ?? s?.back ?? '#fbf7ee', [side]: (e.target as HTMLInputElement).value };
      applyColors();
    });
  }
  $('col-reset').addEventListener('click', () => { override = null; applyColors(); });

  const setStatus = (msg: string, err = false) => { status.textContent = msg; status.classList.toggle('err', err); };

  const compile = () => {
    const text = src.value;
    try { localStorage.setItem(DRAFT, text); } catch { /* ignore */ }
    let script: ModelScript;
    try {
      script = parse(text) as ModelScript;
    } catch (e) {
      setStatus(`YAML: ${(e as Error).message.split('\n')[0]}`, true);
      return;
    }
    try {
      const m = compileModel(script, bases);
      const first = !model;
      const keep = Math.min(steps.cur, m.steps.length);
      model = m;
      if (viewer) viewer.dispose();
      viewer = new FoldViewer($('canvas'), m, { colors: colorsFor(m), onFrame: (t) => steps.frame(t) });
      steps.attach(m, viewer);
      steps.show(first ? 0 : keep, false);
      viewer.bestAngle(false);
      syncInputs();
      setStatus(`${m.title}: ${m.steps.length} steps compiled.`);
      // The finished model, for reference (after the main view, so typing stays responsive).
      clearTimeout(finalTimer);
      finalTimer = window.setTimeout(() => {
        finalView?.dispose();
        finalView = new FoldViewer($('final'), m, { colors: colorsFor(m), cardOffset: false });
        finalView.showStep(m.steps.length, { play: false });
        finalView.bestAngle(false);
      }, 120);
    } catch (e) {
      setStatus((e as Error).message, true);
    }
  };

  const load = async (id: string) => {
    if (id === '__new') { src.value = BLANK; compile(); return; }
    const r = await fetch(`${base}src/${id}.yaml`);
    if (!r.ok) { setStatus(`Could not load "${id}".`, true); return; }
    src.value = await r.text();
    steps.cur = 0;
    model = null;
    compile();
  };

  let timer = 0;
  src.addEventListener('input', () => { clearTimeout(timer); timer = window.setTimeout(compile, 350); });
  src.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = src.selectionStart;
      src.setRangeText('  ', s, src.selectionEnd, 'end');
      src.dispatchEvent(new Event('input'));
    }
  });
  $<HTMLSelectElement>('pick').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v) load(v);
  });
  $('btn-dl').addEventListener('click', () => {
    let id = 'model';
    try { id = (parse(src.value) as ModelScript).id || id; } catch { /* keep default */ }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([src.value], { type: 'text/yaml' }));
    a.download = `${id}.yaml`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const want = params.get('model');
  if (want) {
    $<HTMLSelectElement>('pick').value = want;
    await load(want);
  } else {
    let draft: string | null = null;
    try { draft = localStorage.getItem(DRAFT); } catch { /* ignore */ }
    src.value = draft || BLANK;
    compile();
  }
}
