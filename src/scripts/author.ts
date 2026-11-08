import { parse } from 'yaml';
import { compileModel, type BaseLibrary } from '../engine/compile';
import type { CompiledModel, ModelScript } from '../engine/types';
import { FoldViewer } from './viewer';

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
  let model: CompiledModel | null = null;
  let cur = 0;
  let scrubbing = false;

  const setStatus = (msg: string, err = false) => { status.textContent = msg; status.classList.toggle('err', err); };

  const showStep = (i: number, play = true) => {
    if (!model || !viewer) return;
    const N = model.steps.length;
    cur = Math.max(0, Math.min(N, i));
    viewer.showStep(cur, { play, camera: false });
    const done = cur >= N;
    $('step-label').textContent = done ? 'Finished' : `Step ${cur + 1} of ${N}`;
    $('step-text').textContent = done ? model.finish.text : model.steps[cur].text;
    ($('btn-prev') as HTMLButtonElement).disabled = cur === 0;
    ($('btn-next') as HTMLButtonElement).disabled = done;
  };

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
      const keep = Math.min(cur, m.steps.length);
      model = m;
      if (viewer) viewer.dispose();
      viewer = new FoldViewer($('canvas'), m, {
        colors: Object.fromEntries(m.sheets.map((s) => [s.id, { front: s.front, back: s.back }])),
        onFrame: (t) => { if (!scrubbing) $<HTMLInputElement>('scrub').value = String(Math.round(t * 1000)); },
      });
      showStep(first ? 0 : keep, false);
      viewer.bestAngle(false);
      setStatus(`${m.title}: ${m.steps.length} steps compiled.`);
    } catch (e) {
      setStatus((e as Error).message, true);
    }
  };

  const load = async (id: string) => {
    if (id === '__new') { src.value = BLANK; compile(); return; }
    const r = await fetch(`${base}src/${id}.yaml`);
    if (!r.ok) { setStatus(`Could not load "${id}".`, true); return; }
    src.value = await r.text();
    cur = 0;
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
  $('btn-prev').addEventListener('click', () => showStep(cur - 1));
  $('btn-next').addEventListener('click', () => showStep(cur + 1));
  const scrub = $<HTMLInputElement>('scrub');
  scrub.addEventListener('input', () => { scrubbing = true; viewer?.setT(Number(scrub.value) / 1000); });
  scrub.addEventListener('change', () => (scrubbing = false));
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
