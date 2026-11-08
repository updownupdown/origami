import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { BaseLibrary } from '../src/engine/compile.ts';
import type { ModelScript } from '../src/engine/types.ts';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.yaml') ? [p] : [];
  });
}

export function loadBases(): BaseLibrary {
  const lib: BaseLibrary = {};
  for (const f of walk(path.join(ROOT, 'models/bases'))) {
    const s = parse(fs.readFileSync(f, 'utf8')) as ModelScript;
    lib[`base/${s.id}`] = s;
  }
  return lib;
}

export function loadModels(): { file: string; script: ModelScript }[] {
  return walk(path.join(ROOT, 'models'))
    .filter((f) => !f.includes(`${path.sep}bases${path.sep}`))
    .map((file) => ({ file, script: parse(fs.readFileSync(file, 'utf8')) as ModelScript }));
}
