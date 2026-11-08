import type { CompiledModel } from '../engine/types';

/** A stretch of consecutive steps that work on one sheet (or put the sheets together). */
export interface SheetRun { start: number; end: number; sheet: string | null; label: string }

/**
 * Splits a multi-sheet model's steps into runs by the sheet each step works on. Steps that touch
 * several sheets are "Assemble"; steps that touch none (turning the model, standing it up) stay in
 * the run before them. Returns [] for single-sheet models.
 */
export function sheetRuns(model: CompiledModel): SheetRun[] {
  if (model.sheets.length < 2) return [];
  const name = (id: string | null) => (id ? model.sheets.find((s) => s.id === id)?.name ?? id : 'Assemble');
  const runs: SheetRun[] = [];
  let cur: string | null | undefined;
  model.steps.forEach((s, i) => {
    const sh = s.sheets ?? [];
    let key: string | null | undefined = sh.length === 1 ? sh[0] : sh.length > 1 ? null : cur;
    if (key === undefined) key = model.sheets[0].id;
    if (!runs.length || key !== cur) runs.push({ start: i, end: i, sheet: key, label: name(key) });
    else runs[runs.length - 1].end = i;
    cur = key;
  });
  return runs;
}

/** The run that holds step i (the last run for the finished model). */
export function runAt(runs: SheetRun[], i: number): SheetRun | undefined {
  return runs.find((r) => i >= r.start && i <= r.end) ?? runs[runs.length - 1];
}
