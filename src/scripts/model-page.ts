import type { CompiledModel } from '../engine/types';
import { creasePatternSvg, stepSvg } from '../engine/svg';
import { FoldViewer, type Colors } from './viewer';

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

  let scrubbing = false;
  const viewer = new FoldViewer($('canvas'), model, {
    colors, thumbnail: thumb,
    onFrame: (t) => { if (!scrubbing) ($<HTMLInputElement>('scrub')).value = String(Math.round(t * 1000)); },
  });
  (window as any).viewer = viewer;

  if (thumb) {
    viewer.showStep(model.steps.length, { play: false });
    requestAnimationFrame(() => { viewer.renderNow(); (window as any).__thumbReady = true; });
    return;
  }

  const N = model.steps.length;
  const startAt = Math.min(N, Math.max(0, Number(params.get('step') ?? load(`origami:step:${id}`, 1)) - 1));

  // --- Progress bar and step list
  $('progress').innerHTML = model.steps.map((_, i) => `<button aria-label="Step ${i + 1}" data-i="${i}"></button>`).join('');
  $('progress').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b) go(Number(b.dataset.i));
  });
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
  };
  $('steplist').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b) { go(Number(b.dataset.i)); if (matchMedia('(max-width: 640px)').matches) toggleDrawer(false); }
  });
  const toggleDrawer = (open?: boolean) => {
    const d = $('drawer');
    const show = open ?? d.hidden;
    if (show) { buildList(); toggleCp(false); }
    d.hidden = !show;
    $('btn-steps').setAttribute('aria-expanded', String(show));
    if (show) d.querySelector('.now')?.scrollIntoView({ block: 'nearest' });
  };
  $('btn-steps').addEventListener('click', () => toggleDrawer());
  $('btn-close-steps').addEventListener('click', () => toggleDrawer(false));

  // --- Crease pattern
  const toggleCp = (open?: boolean) => {
    const c = $('cp');
    const show = open ?? c.hidden;
    if (show) {
      toggleDrawer(false);
      $('cp-body').innerHTML = model.sheets.map((s) => `${model.sheets.length > 1 ? `<p class="hint">${esc(s.name)}</p>` : ''}${creasePatternSvg(model, s.id)}`).join('');
    }
    c.hidden = !show;
    $('btn-cp').setAttribute('aria-pressed', String(show));
  };
  $('btn-cp').addEventListener('click', () => toggleCp());
  $('btn-close-cp').addEventListener('click', () => toggleCp(false));

  // --- Step navigation
  const show = (i: number, play = true) => {
    viewer.showStep(i, { play });
    const finished = i >= N;
    $('step-label').textContent = finished ? 'Finished' : `${model.steps[i].group ? `${model.steps[i].group} · ` : ''}Step ${i + 1} of ${N}`;
    $('step-text').textContent = finished ? model.finish.text : model.steps[i].text;
    const tip = $('step-tip');
    tip.hidden = finished || !model.steps[i].tip;
    tip.textContent = finished ? '' : model.steps[i].tip ?? '';
    $('progress').querySelectorAll('button').forEach((b, k) => { b.className = k < i ? 'past' : k === i ? 'now' : ''; });
    $('steplist').querySelectorAll('button').forEach((b, k) => b.classList.toggle('now', k === i));
    ($('btn-prev') as HTMLButtonElement).disabled = i === 0;
    ($('btn-next') as HTMLButtonElement).disabled = finished;
    $('finish').hidden = !finished;
    if (finished) $('finish-text').textContent = `${model.title}, ${model.steps.length} steps.`;
    save(`origami:step:${id}`, i + 1);
    const url = new URL(location.href);
    url.searchParams.set('step', String(i + 1));
    history.replaceState(null, '', url);
  };
  let cur = startAt;
  const go = (i: number) => { cur = Math.max(0, Math.min(N, i)); show(cur); };
  $('btn-prev').addEventListener('click', () => go(cur - 1));
  $('btn-next').addEventListener('click', () => go(cur + 1));
  $('btn-play').addEventListener('click', () => { viewer.setT(0); viewer.play(); });
  $('btn-best').addEventListener('click', () => viewer.bestAngle());
  $('btn-in').addEventListener('click', () => viewer.zoomBy(1.25));
  $('btn-out').addEventListener('click', () => viewer.zoomBy(0.8));
  const scrub = $<HTMLInputElement>('scrub');
  scrub.addEventListener('input', () => { scrubbing = true; viewer.setT(Number(scrub.value) / 1000); });
  scrub.addEventListener('change', () => (scrubbing = false));
  addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest('input, textarea, select, dialog')) return;
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); go(cur + 1); }
    if (e.key === 'ArrowLeft') go(cur - 1);
    if (e.key === 'r') { viewer.setT(0); viewer.play(); }
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
    if (!$('drawer').hidden) { buildList(); show(cur, false); }
  };
  const buildPaper = () => {
    $('paper-list').innerHTML = model.sheets.map((s) => `
      <div class="paper-row" data-sheet="${s.id}">
        <span class="nm">${s.count > 1 ? `${s.count} × ` : ''}${esc(s.name)}<small>${s.w === s.h ? `${fmt(s.w)} square` : `${fmt(s.w)} × ${fmt(s.h)}`}</small></span>
        <label><input type="color" data-side="front" value="${colors[s.id].front}" aria-label="${esc(s.name)} front colour">Front</label>
        <label><input type="color" data-side="back" value="${colors[s.id].back}" aria-label="${esc(s.name)} back colour">Back</label>
      </div>
      <div class="presets" data-sheet="${s.id}">${PRESETS.map((c) => `<button style="background:${c}" data-color="${c}" aria-label="Use ${c} for the front"></button>`).join('')}</div>`).join('')
      + `<p><button class="btn small" id="btn-reset-colors">Reset to suggested colours</button></p>`;
  };
  $('paper-list').addEventListener('input', (e) => {
    const inp = e.target as HTMLInputElement;
    const sheet = inp.closest<HTMLElement>('[data-sheet]')?.dataset.sheet;
    if (!sheet || !inp.dataset.side) return;
    setColors({ ...colors, [sheet]: { ...colors[sheet], [inp.dataset.side]: inp.value } });
  });
  $('paper-list').addEventListener('click', (e) => {
    const b = e.target as HTMLElement;
    if (b.id === 'btn-reset-colors') { setColors({ ...defaults }); buildPaper(); return; }
    const sheet = b.closest<HTMLElement>('.presets')?.dataset.sheet;
    if (sheet && b.dataset.color) { setColors({ ...colors, [sheet]: { ...colors[sheet], front: b.dataset.color } }); buildPaper(); }
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
  $('btn-info').addEventListener('click', () => infoDlg.showModal());

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
  show(cur, false);
  viewer.bestAngle(false);
}
