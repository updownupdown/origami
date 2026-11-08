import type { CompiledModel } from '../engine/types';
import { creasePatternSvg, stepSvg } from '../engine/svg';
import { FoldViewer, type Colors } from './viewer';
import { StepControls } from './step-controls';

const base = (window as any).__BASE__ as string;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const PRESETS = ['#e8642c', '#d93a3a', '#e46aa6', '#e889c0', '#9b6bd0', '#4a6fd8', '#3fa7d6', '#3fb39a', '#5fbf6a', '#9bd36a', '#f2c94c', '#c9a27a', '#8a5a33', '#2b2a28', '#fbf7ee', '#ffffff'];

function load<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function save(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

export async function initModelPage() {
  const stage = $('stage');
  const id = stage.dataset.id!;
  const params = new URLSearchParams(location.search);
  const thumb = params.has('thumb');
  const model: CompiledModel = await (await fetch(`${base}models/${id}.json`)).json();

  const defaults: Colors = Object.fromEntries(model.sheets.map((s) => [s.id, { front: s.front, back: s.back }]));
  let colors: Colors = thumb ? defaults : { ...defaults, ...load(`origami:colors:${id}`, {}) };
  let units: 'cm' | 'in' = load('origami:units', 'cm');

  if (thumb) {
    document.querySelectorAll<HTMLElement>('.stage > :not(.canvas)').forEach((e) => (e.style.display = 'none'));
    document.body.style.background = 'transparent';
  }

  const N = model.steps.length;
  const steps = new StepControls({
    onStep: (i) => {
      $('steplist').querySelectorAll('button').forEach((b, k) => b.classList.toggle('now', k === i));
      $('finish').hidden = i < N;
      if (i >= N) $('finish-text').textContent = `${model.title}, ${N} steps.`;
    },
    onLand: (i) => {
      save(`origami:step:${id}`, i + 1);
      const url = new URL(location.href);
      url.searchParams.set('step', String(i + 1));
      history.replaceState(null, '', url);
    },
  });
  const viewer = new FoldViewer($('canvas'), model, {
    colors, thumbnail: thumb,
    onFrame: (t) => { if (!thumb) steps.frame(t); },
  });
  (window as any).viewer = viewer;

  if (thumb) {
    viewer.showStep(model.steps.length, { play: false });
    requestAnimationFrame(() => { viewer.renderNow(); (window as any).__thumbReady = true; });
    return;
  }
  steps.attach(model, viewer);
  const startAt = Math.min(N, Math.max(0, Number(params.get('step') ?? load(`origami:step:${id}`, 1)) - 1));

  let listBuilt = false;
  const buildList = () => {
    if (listBuilt) return;
    listBuilt = true;
    let lastGroup = '';
    $('steplist').innerHTML = model.steps.map((s, i) => {
      const grp = s.group && s.group !== lastGroup ? `<span class="grp">${esc(s.group)}</span>` : '';
      lastGroup = s.group ?? '';
      return `<li><button data-i="${i}"><span class="n">${i + 1}</span><span class="th">${stepSvg(model, i, { width: 112, height: 112, colors, padding: 0.06 })}</span><span class="tx">${grp}${esc(s.text)}</span></button></li>`;
    }).join('') + `<li><button data-i="${N}"><span class="n">✓</span><span class="tx">Finished</span></button></li>`;
    $('steplist').querySelectorAll('button').forEach((b, k) => b.classList.toggle('now', k === steps.cur));
  };
  $('steplist').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b) { steps.go(Number(b.dataset.i)); if (matchMedia('(max-width: 640px)').matches) toggleDrawer(false); }
  });
  const toggleDrawer = (open?: boolean) => {
    const d = $('drawer');
    const show = open ?? d.hidden;
    if (show) buildList();
    d.hidden = !show;
    $('btn-steps').setAttribute('aria-expanded', String(show));
    if (show) d.querySelector('.now')?.scrollIntoView({ block: 'nearest' });
  };
  $('btn-steps').addEventListener('click', () => toggleDrawer());
  $('btn-close-steps').addEventListener('click', () => toggleDrawer(false));

  $('btn-best').addEventListener('click', () => viewer.bestAngle());
  $('btn-in').addEventListener('click', () => viewer.zoomBy(1.25));
  $('btn-out').addEventListener('click', () => viewer.zoomBy(0.8));
  addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest('input, textarea, select, dialog')) return;
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); steps.go(steps.cur + 1); }
    if (e.key === 'ArrowLeft') steps.go(steps.cur - 1);
    if (e.key === 'r') steps.playRepeats();
    if (e.key === 'b') viewer.bestAngle();
  });

  // --- Paper colours and units
  const renderSwatches = () => {
    $('swatches').innerHTML = model.sheets.slice(0, 3).map((s) => `<i style="background:${colors[s.id].front}"></i><i style="background:${colors[s.id].back}"></i>`).join('');
    document.querySelectorAll<HTMLElement>('.sw[data-sheet]').forEach((el) => {
      const c = colors[el.dataset.sheet!];
      el.style.background = `linear-gradient(135deg, ${c.front} 50%, ${c.back} 50%)`;
    });
  };
  const fmt = (cm: number) => (units === 'in' ? `${(cm / 2.54).toFixed(cm / 2.54 < 10 ? 2 : 1).replace(/\.?0+$/, '')} in` : `${cm} cm`);
  const renderUnits = () => {
    document.querySelectorAll<HTMLElement>('[data-size]').forEach((el) => {
      const w = Number(el.dataset.size), h = Number(el.dataset.sizeH ?? w);
      el.textContent = el.dataset.sizeH === undefined ? fmt(w) : w === h ? `${fmt(w)} square` : `${fmt(w)} × ${fmt(h)}`;
    });
    document.querySelectorAll<HTMLElement>('[data-unit]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.unit === units)));
  };
  const setColors = (c: Colors) => {
    colors = c;
    viewer.setColors(colors);
    save(`origami:colors:${id}`, colors);
    renderSwatches();
    listBuilt = false;
    if (!$('drawer').hidden) buildList();
  };
  // Which side of each sheet the swatches apply to.
  const side: Record<string, 'front' | 'back'> = Object.fromEntries(model.sheets.map((s) => [s.id, 'front']));
  const buildPaper = () => {
    $('paper-list').innerHTML = model.sheets.map((s) => {
      const c = colors[s.id], sel = c[side[s.id]].toLowerCase();
      const sideBtn = (k: 'front' | 'back', name: string, sub: string) =>
        `<button data-pick="${k}" aria-pressed="${side[s.id] === k}"><i style="background:${c[k]}"></i><span>${name}<small>${sub}</small></span></button>`;
      return `<div class="sheet-block" data-sheet="${s.id}">
        ${model.sheets.length > 1 ? `<p class="nm">${s.count > 1 ? `${s.count} × ` : ''}${esc(s.name)}<small>${s.w === s.h ? `${fmt(s.w)} square` : `${fmt(s.w)} × ${fmt(s.h)}`}</small></p>` : ''}
        <div class="sides">${sideBtn('front', 'Front', 'coloured side')}${sideBtn('back', 'Back', 'other side')}</div>
        <div class="presets">${PRESETS.map((col) => `<button style="background:${col}" data-color="${col}" aria-pressed="${col === sel}" aria-label="${side[s.id]} colour ${col}"></button>`).join('')}
          <label title="Custom colour" aria-label="Custom ${side[s.id]} colour">+<input type="color" value="${c[side[s.id]]}"></label></div>
      </div>`;
    }).join('') + `<p><button class="btn small" id="btn-reset-colors">Reset to suggested colours</button></p>`;
  };
  $('paper-list').addEventListener('input', (e) => {
    const inp = e.target as HTMLInputElement;
    const sheet = inp.closest<HTMLElement>('[data-sheet]')?.dataset.sheet;
    if (!sheet || inp.type !== 'color') return;
    setColors({ ...colors, [sheet]: { ...colors[sheet], [side[sheet]]: inp.value } });
    const sw = inp.closest('.sheet-block')!.querySelector<HTMLElement>(`[data-pick="${side[sheet]}"] i`);
    if (sw) sw.style.background = inp.value;
  });
  $('paper-list').addEventListener('change', (e) => { if ((e.target as HTMLInputElement).type === 'color') buildPaper(); });
  $('paper-list').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    if (b.id === 'btn-reset-colors') { setColors({ ...defaults }); buildPaper(); return; }
    const sheet = b.closest<HTMLElement>('[data-sheet]')?.dataset.sheet;
    if (!sheet) return;
    if (b.dataset.pick) { side[sheet] = b.dataset.pick as 'front' | 'back'; buildPaper(); return; }
    if (b.dataset.color) { setColors({ ...colors, [sheet]: { ...colors[sheet], [side[sheet]]: b.dataset.color } }); buildPaper(); }
  });
  document.querySelectorAll<HTMLButtonElement>('[data-unit]').forEach((b) => b.addEventListener('click', () => {
    units = b.dataset.unit as 'cm' | 'in';
    save('origami:units', units);
    renderUnits();
    buildPaper();
  }));
  const dlg = (name: string) => {
    const d = $<HTMLDialogElement>(name);
    d.addEventListener('click', (e) => {
      if (e.target === d || (e.target as HTMLElement).closest('[data-close]')) d.close();
    });
    return d;
  };
  const paperDlg = dlg('dlg-paper'), infoDlg = dlg('dlg-info');
  $('btn-paper').addEventListener('click', () => { buildPaper(); paperDlg.showModal(); });
  let cpBuilt = false;
  $('btn-info').addEventListener('click', () => {
    if (!cpBuilt) {
      cpBuilt = true;
      $('cp-body').innerHTML = model.sheets.map((s) => `${model.sheets.length > 1 ? `<p class="hint">${esc(s.name)}</p>` : ''}${creasePatternSvg(model, s.id)}`).join('');
    }
    infoDlg.showModal();
  });

  // --- Finished
  const doneList: string[] = load('origami:done', []);
  const doneBtn = $('btn-done');
  doneBtn.setAttribute('aria-pressed', String(doneList.includes(id)));
  doneBtn.addEventListener('click', () => {
    const list: string[] = load('origami:done', []);
    const on = !list.includes(id);
    save('origami:done', on ? [...list, id] : list.filter((x) => x !== id));
    doneBtn.setAttribute('aria-pressed', String(on));
  });

  renderSwatches();
  renderUnits();
  steps.show(startAt, false);
  viewer.bestAngle(false);
  // Show the opening step once the page has settled.
  setTimeout(() => { if (steps.cur === startAt && !steps.scrubbing) steps.playRepeats(); }, 600);
}
