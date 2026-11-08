import MiniSearch from 'minisearch';
import { DIFFICULTY, categoryLabel } from '../lib/categories';
import { icon } from '../lib/icons';

interface Entry {
  id: string; kind: 'foldable' | 'link'; title: string; family?: string; variant?: string; aliases: string[];
  categories: string[]; tags: string[]; difficulty: number; description: string; designer: string;
  steps?: number; sheets: number; paper?: string; url?: string; source?: string;
}

const base = (window as any).__BASE__ as string;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function store<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } }

export async function initBrowse() {
  const res = await fetch(`${base}search.json`);
  const all: Entry[] = await res.json();
  const ms = new MiniSearch<Entry>({
    fields: ['title', 'family', 'variant', 'aliasesText', 'tagsText', 'catsText', 'designer', 'description'],
    storeFields: ['id'],
    extractField: (doc, f) => {
      if (f === 'aliasesText') return doc.aliases.join(' ');
      if (f === 'tagsText') return doc.tags.join(' ');
      if (f === 'catsText') return doc.categories.map((c) => `${c} ${categoryLabel(c)}`).join(' ');
      return (doc as any)[f] ?? '';
    },
    searchOptions: { boost: { title: 3, family: 2, aliasesText: 2 }, prefix: true, fuzzy: 0.2 },
  });
  ms.addAll(all);
  const byId = new Map(all.map((e) => [e.id, e]));
  const done: string[] = store('origami:done', []);

  const saved = store<any>('origami:browse', {});
  const state: { q: string; cat: string; levels: number[]; sheets: string; links: boolean } = {
    q: saved.q ?? '', cat: saved.cat ?? '', sheets: saved.sheets ?? '', links: !!saved.links,
    levels: Array.isArray(saved.levels) ? saved.levels : saved.difficulty ? [Number(saved.difficulty)] : [],
  };
  const q = $<HTMLInputElement>('q'), links = $<HTMLInputElement>('links');
  const catBtn = $<HTMLButtonElement>('cat-btn'), catPanel = $('cat-panel');
  const catOpts = [...catPanel.querySelectorAll<HTMLButtonElement>('button[data-cat]')];
  const params = new URLSearchParams(location.search);
  if (params.has('q')) state.q = params.get('q')!;
  if (params.has('cat')) state.cat = params.get('cat')!;
  q.value = state.q; links.checked = state.links;
  if (!catOpts.some((b) => b.dataset.cat === state.cat)) state.cat = '';
  const levelBtns = [...document.querySelectorAll<HTMLButtonElement>('#levels button')];
  const sheetBtns = [...document.querySelectorAll<HTMLButtonElement>('#sheets button')];

  const render = () => {
    levelBtns.forEach((b) => b.setAttribute('aria-pressed', String(state.levels.includes(Number(b.dataset.level)))));
    sheetBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.sheets === state.sheets)));
    catBtn.classList.toggle('on', !!state.cat);
    const selected = catOpts.find((b) => b.dataset.cat === state.cat);
    $('cat-label').textContent = selected?.querySelector('span')?.textContent ?? 'All categories';
    catOpts.forEach((b) => b.setAttribute('aria-selected', String(b === selected)));
    // Counts for each category under the other filters.
    const pool = all.filter((e) => (state.links || e.kind !== 'link')
      && (!state.levels.length || state.levels.includes(e.difficulty))
      && (state.sheets !== '1' || e.sheets === 1) && (state.sheets !== '2' || e.sheets >= 2));
    catOpts.forEach((b) => {
      const c = b.dataset.cat ?? '';
      const n = c ? pool.filter((e) => e.categories.some((x) => x === c || x.startsWith(`${c}/`))).length : pool.length;
      b.querySelector('b')!.textContent = String(n);
      b.classList.toggle('empty', n === 0);
    });
    $('clear').hidden = !(state.cat || state.levels.length || state.sheets);
    let list: Entry[] = state.q.trim() ? ms.search(state.q.trim()).map((r) => byId.get(r.id)!) : all;
    list = list.filter((e) => {
      if (!state.links && e.kind === 'link') return false;
      if (state.cat && !e.categories.some((c) => c === state.cat || c.startsWith(`${state.cat}/`))) return false;
      if (state.levels.length && !state.levels.includes(e.difficulty)) return false;
      if (state.sheets === '1' && e.sheets !== 1) return false;
      if (state.sheets === '2' && e.sheets < 2) return false;
      return true;
    });
    const n = list.filter((e) => e.kind === 'foldable').length, l = list.length - n;
    $('status').textContent = list.length ? `${n} foldable model${n === 1 ? '' : 's'}${state.links ? `, ${l} link-only` : ''}` : 'Nothing matches. Try another word or clear a filter.';
    $('grid').innerHTML = list.slice(0, 600).map(card).join('');
    save('origami:browse', state);
  };

  const card = (e: Entry) => {
    const dots = `<span class="dots" aria-label="${DIFFICULTY[e.difficulty]}">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= e.difficulty ? 'on' : ''}"></i>`).join('')}</span>`;
    const title = esc(e.title) + (e.variant && !e.title.toLowerCase().includes(e.variant.toLowerCase()) ? ` <span style="color:var(--ink-soft)">· ${esc(e.variant)}</span>` : '');
    if (e.kind === 'link') {
      return `<li><a class="tile link" href="${esc(e.url ?? '#')}" target="_blank" rel="noopener">
        <span class="thumb"><span class="glyph">${esc(e.title.slice(0, 1))}</span><span class="chip badge">${icon('external')}&nbsp;Link only</span></span>
        <span class="meta"><span class="name">${title}</span><span class="sub">${dots}<span>${esc(e.designer || 'Unknown designer')}</span></span></span></a></li>`;
    }
    const sub = [`${e.steps} steps`, e.sheets > 1 ? `${e.sheets} sheets` : ''].filter(Boolean).join(' · ');
    return `<li><a class="tile" data-id="${e.id}" href="${base}models/${e.id}/">
      <span class="thumb"><img src="${base}thumbs/${e.id}.png" alt="" loading="lazy" onerror="this.onerror=null;this.src='${base}thumbs/${e.id}.svg'">${done.includes(e.id) ? `<span class="done" title="Folded">${icon('check')}</span>` : ''}</span>
      <span class="meta"><span class="name">${title}</span><span class="sub">${dots}<span>${DIFFICULTY[e.difficulty]} · ${sub}</span></span></span></a></li>`;
  };

  q.addEventListener('input', () => { state.q = q.value; render(); });
  const openCats = (open: boolean) => {
    catPanel.hidden = !open;
    catBtn.setAttribute('aria-expanded', String(open));
    if (open) (catOpts.find((b) => b.getAttribute('aria-selected') === 'true') ?? catOpts[0]).focus();
  };
  catBtn.addEventListener('click', () => openCats(catPanel.hidden));
  catOpts.forEach((b) => b.addEventListener('click', () => { state.cat = b.dataset.cat ?? ''; render(); openCats(false); catBtn.focus(); }));
  catPanel.addEventListener('keydown', (e) => {
    const i = catOpts.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { openCats(false); catBtn.focus(); }
    if (e.key === 'ArrowDown') { catOpts[Math.min(catOpts.length - 1, i + 1)].focus(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { catOpts[Math.max(0, i - 1)].focus(); e.preventDefault(); }
  });
  document.addEventListener('pointerdown', (e) => { if (!catPanel.hidden && !$('catpick').contains(e.target as Node)) openCats(false); });
  links.addEventListener('change', () => { state.links = links.checked; render(); });
  levelBtns.forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.level);
    state.levels = state.levels.includes(n) ? state.levels.filter((x) => x !== n) : [...state.levels, n].sort();
    render();
  }));
  sheetBtns.forEach((b) => b.addEventListener('click', () => { state.sheets = b.dataset.sheets ?? ''; render(); }));
  $('clear').addEventListener('click', () => { state.cat = ''; state.levels = []; state.sheets = ''; render(); });
  render();
  livePreviews();
}

/**
 * Hovering a tile (or pressing and holding it on touch) swaps its picture for a live 3D view that
 * turns slowly and can be dragged round. Only one runs at a time, so it stays cheap.
 */
function livePreviews() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let active: { tile: HTMLElement; box: HTMLElement; viewer: { dispose(): void } } | null = null;
  let timer = 0;
  const models = new Map<string, Promise<unknown>>();
  const stop = () => {
    clearTimeout(timer);
    if (!active) return;
    active.viewer.dispose();
    active.box.remove();
    active.tile.classList.remove('live');
    active = null;
  };
  const start = async (tile: HTMLElement) => {
    const id = tile.dataset.id!;
    if (active?.tile === tile) return;
    stop();
    if (!models.has(id)) models.set(id, fetch(`${base}models/${id}.json`).then((r) => r.json()));
    const [model, { FoldViewer }] = await Promise.all([models.get(id)!, import('./viewer')]);
    if (!tile.matches(':hover') && !tile.classList.contains('pressed')) return;
    stop();
    const thumb = tile.querySelector<HTMLElement>('.thumb')!;
    const box = document.createElement('div');
    box.className = 'live-box';
    thumb.append(box);
    const m = model as any;
    const colors = Object.fromEntries(m.sheets.map((s: any) => [s.id, { front: s.front, back: s.back }]));
    const viewer = new FoldViewer(box, m, { colors, spin: true });
    viewer.showStep(m.steps.length, { play: false });
    tile.classList.add('live');
    active = { tile, box, viewer };
  };
  const grid = document.getElementById('grid')!;
  grid.addEventListener('pointerover', (e) => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>('.tile[data-id]');
    if (!tile || e.pointerType === 'touch' || active?.tile === tile) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => start(tile), 280);
  });
  grid.addEventListener('pointerout', (e) => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>('.tile[data-id]');
    if (!tile || tile.contains(e.relatedTarget as Node)) return;
    if (e.pointerType === 'touch') return;
    stop();
  });
  // Touch: press and hold the picture to spin it; tap elsewhere to stop.
  grid.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const tile = (e.target as HTMLElement).closest<HTMLElement>('.tile[data-id]');
    if (!tile || active?.tile === tile) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => { tile.classList.add('pressed'); start(tile); }, 450);
  });
  grid.addEventListener('pointerup', () => clearTimeout(timer));
  document.addEventListener('pointerdown', (e) => { if (active && !active.tile.contains(e.target as Node)) { active.tile.classList.remove('pressed'); stop(); } });
  // Dragging inside the live view should turn the model, not follow the link.
  grid.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('.live-box') && dragged) { e.preventDefault(); dragged = false; } }, true);
  let dragged = false, downX = 0, downY = 0;
  grid.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; dragged = false; });
  grid.addEventListener('pointermove', (e) => { if (e.buttons && Math.hypot(e.clientX - downX, e.clientY - downY) > 6) dragged = true; });
  grid.addEventListener('contextmenu', (e) => { if ((e.target as HTMLElement).closest('.tile.pressed')) e.preventDefault(); });
  addEventListener('pagehide', stop);
}
