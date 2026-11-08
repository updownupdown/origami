import fs from 'node:fs';
import path from 'node:path';
import type { CompiledModel } from '../src/engine/types.ts';
import { ROOT } from './lib.ts';

export interface IndexEntry {
  id: string;
  kind: 'foldable' | 'link';
  title: string;
  family?: string;
  variant?: string;
  aliases: string[];
  categories: string[];
  tags: string[];
  difficulty: number;
  description: string;
  designer: string;
  steps?: number;
  sheets: number;
  paper?: string;
  url?: string;
  source?: string;
}

export function buildIndex(models: CompiledModel[]): IndexEntry[] {
  const entries: IndexEntry[] = models.map((m) => ({
    id: m.id,
    kind: 'foldable',
    title: m.title,
    family: m.family,
    variant: m.variant,
    aliases: m.aliases,
    categories: m.categories,
    tags: m.tags,
    difficulty: m.difficulty,
    description: m.description,
    designer: m.credits.designer,
    steps: m.steps.length,
    sheets: m.sheets.reduce((n, s) => n + s.count, 0),
    paper: m.sheets.map((s) => (s.w === s.h ? `${s.w} cm square` : `${s.w} × ${s.h} cm`)).join(', '),
  }));
  const catDir = path.join(ROOT, 'data/catalog');
  if (fs.existsSync(catDir)) {
    for (const f of fs.readdirSync(catDir).filter((x) => x.endsWith('.json'))) {
      const list = JSON.parse(fs.readFileSync(path.join(catDir, f), 'utf8')) as IndexEntry[];
      for (const e of list) entries.push({ ...e, kind: 'link' });
    }
  }
  return entries.sort((a, b) => (a.kind === b.kind ? a.difficulty - b.difficulty || a.title.localeCompare(b.title) : a.kind === 'foldable' ? -1 : 1));
}
