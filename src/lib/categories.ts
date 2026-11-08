export const CATEGORIES: { id: string; label: string; children?: { id: string; label: string }[] }[] = [
  { id: 'animals', label: 'Animals', children: [
    { id: 'animals/mammals', label: 'Mammals' },
    { id: 'animals/birds', label: 'Birds' },
    { id: 'animals/sea-life', label: 'Sea life' },
    { id: 'animals/insects', label: 'Insects' },
    { id: 'animals/reptiles-amphibians', label: 'Reptiles and amphibians' },
    { id: 'animals/mythical', label: 'Mythical' },
  ] },
  { id: 'plants', label: 'Plants', children: [
    { id: 'plants/flowers', label: 'Flowers' },
    { id: 'plants/potted', label: 'Potted plants' },
    { id: 'plants/leaves-trees', label: 'Leaves and trees' },
  ] },
  { id: 'objects', label: 'Objects', children: [
    { id: 'objects/toys', label: 'Toys' },
    { id: 'objects/household', label: 'Household' },
    { id: 'objects/wearables', label: 'Hats and wearables' },
    { id: 'objects/vehicles', label: 'Boats and planes' },
  ] },
  { id: 'boxes', label: 'Boxes and pots', children: [
    { id: 'boxes/boxes', label: 'Boxes' },
    { id: 'boxes/pots', label: 'Pots and vases' },
    { id: 'boxes/envelopes', label: 'Envelopes and wallets' },
  ] },
  { id: 'action', label: 'Action' },
  { id: 'tessellations', label: 'Tessellations' },
  { id: 'geometric', label: 'Geometric', children: [
    { id: 'geometric/stars', label: 'Stars' },
    { id: 'geometric/modular', label: 'Modular' },
    { id: 'geometric/shapes', label: 'Shapes' },
  ] },
  { id: 'holidays', label: 'Holidays' },
  { id: 'bases', label: 'Bases' },
];

export const DIFFICULTY = ['', 'Beginner', 'Easy', 'Intermediate', 'Advanced', 'Complex'];

export function categoryLabel(id: string): string {
  for (const c of CATEGORIES) {
    if (c.id === id) return c.label;
    for (const k of c.children ?? []) if (k.id === id) return k.label;
  }
  return id;
}
