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

  const state = store('origami:browse', { q: '', cat: '', difficulty: '', sheets: '', links: false });
  const q = $<HTMLInputElement>('q'), diff = $<HTMLSelectElement>('difficulty'), sheets = $<HTMLSelectElement>('sheets'), links = $<HTMLInputElement>('links');
  const params = new URLSearchParams(location.search);
  if (params.has('q')) state.q = params.get('q')!;
  q.value = state.q; diff.value = state.difficulty; sheets.value = state.sheets; links.checked = state.links;
  const cats = [...document.querySelectorAll<HTMLButtonElement>('#cats button')];

  const render = () => {
    cats.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cat === state.cat)));
    let list: Entry[] = state.q.trim() ? ms.search(state.q.trim()).map((r) => byId.get(r.id)!) : all;
    list = list.filter((e) => {
      if (!state.links && e.kind === 'link') return false;
      if (state.cat && !e.categories.some((c) => c === state.cat || c.startsWith(`${state.cat}/`))) return false;
      if (state.difficulty && e.difficulty !== Number(state.difficulty)) return false;
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
    return `<li><a class="tile" href="${base}models/${e.id}/">
      <span class="thumb"><img src="${base}thumbs/${e.id}.png" alt="" loading="lazy" onerror="this.onerror=null;this.src='${base}thumbs/${e.id}.svg'">${done.includes(e.id) ? `<span class="done" title="Folded">${icon('check')}</span>` : ''}</span>
      <span class="meta"><span class="name">${title}</span><span class="sub">${dots}<span>${DIFFICULTY[e.difficulty]} · ${sub}</span></span></span></a></li>`;
  };

  q.addEventListener('input', () => { state.q = q.value; render(); });
  diff.addEventListener('change', () => { state.difficulty = diff.value; render(); });
  sheets.addEventListener('change', () => { state.sheets = sheets.value; render(); });
  links.addEventListener('change', () => { state.links = links.checked; render(); });
  cats.forEach((b) => b.addEventListener('click', () => { state.cat = b.dataset.cat ?? ''; render(); }));
  render();
}
