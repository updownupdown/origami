// Builds a link-only catalog of models listed on origami-database.com.
// Facts and links only: title, designer, difficulty, sheets, labels and the page URL.
// No images, descriptions or instructions are copied. Runs in CI (see .github/workflows/catalog.yml).
import fs from 'node:fs';

const SITE = 'https://origami-database.com';
const OUT = 'data/catalog/origami-database.json';
const UA = 'origami-catalog/1.0 (+https://updownupdown.github.io/origami/)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, json = false) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: json ? 'application/json' : 'text/html' } });
    if (r.ok) return { body: json ? await r.json() : await r.text(), headers: r.headers };
    if (r.status === 404 || r.status === 400) return null;
    await sleep(2000 * (attempt + 1));
  }
  return null;
}

const decode = (s) => String(s ?? '')
  .replace(/<[^>]+>/g, '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

const DIFF = [
  [/super complex|expert|very complex/i, 5],
  [/complex|advanced|high/i, 4],
  [/intermediate|moderate|medium/i, 3],
  [/easy|low/i, 2],
  [/simple|beginner|very easy/i, 1],
];
const difficultyOf = (s) => (DIFF.find(([re]) => re.test(s ?? '')) ?? [null, 3])[1];

const CATS = [
  [/\b(?:dragon|dinosaur|unicorn|pegasus|phoenix|griffin|monster|demon|creature)(?:s|es)?\b/i, 'animals/mythical'],
  [/\b(?:bird|crane|swan|owl|eagle|parrot|penguin|duck|hen|chicken|rooster|peacock|flamingo|hummingbird|pigeon|dove|crow|raven|heron|stork|toucan)(?:s|es)?\b/i, 'animals/birds'],
  [/\b(?:fish|shark|whale|dolphin|octopus|squid|crab|lobster|shrimp|jellyfish|seahorse|turtle|ray|starfish|sea)(?:s|es)?\b/i, 'animals/sea-life'],
  [/\b(?:insect|beetle|butterfly|moth|ant|bee|wasp|spider|scorpion|mantis|dragonfly|cicada|grasshopper|cricket|ladybug|stag)(?:s|es)?\b/i, 'animals/insects'],
  [/\b(?:frog|toad|snake|lizard|gecko|chameleon|crocodile|alligator|salamander|newt|tortoise)(?:s|es)?\b/i, 'animals/reptiles-amphibians'],
  [/\b(?:flower|rose|lily|tulip|leaf|leaves|tree|plant|cactus|succulent|iris|orchid|lotus|sunflower)(?:s|es)?\b/i, 'plants/flowers'],
  [/\b(?:box|tray|bowl|dish|container|envelope|wallet)(?:s|es)?\b/i, 'boxes/boxes'],
  [/\b(?:star|cube|polyhedron|polyhedra|icosahedron|dodecahedron|octahedron|sonobe|kusudama|modular)(?:s|es)?\b/i, 'geometric/modular'],
  [/\b(?:tessellation|twist|pleat)(?:s|es)?\b/i, 'tessellations'],
  [/\b(?:santa|christmas|halloween|pumpkin|valentine|heart|easter)(?:s|es)?\b/i, 'holidays'],
  [/\b(?:human|man|woman|person|samurai|knight|ninja|angel|mask|face|hand|skull|figure)(?:s|es)?\b/i, 'objects/toys'],
  [/\b(?:plane|boat|ship|car|train|rocket|tank|helicopter|vehicle)(?:s|es)?\b/i, 'objects/vehicles'],
  [/\b(?:dog|cat|fox|wolf|bear|rabbit|mouse|rat|horse|deer|elephant|giraffe|lion|tiger|cow|pig|sheep|goat|monkey|ape|gorilla|kangaroo|koala|panda|squirrel|bat|hedgehog|camel|rhino|hippo|zebra|moose|bison|otter|raccoon|mammal)(?:s|es)?\b/i, 'animals/mammals'],
];
const categoriesOf = (text) => {
  const hit = CATS.filter(([re]) => re.test(text)).map(([, c]) => c);
  return [...new Set(hit)].slice(0, 2);
};

const slug = (url) => url.replace(/\/$/, '').split('/').pop();

async function fromApi() {
  const first = await get(`${SITE}/wp-json/wp/v2/model?per_page=100&page=1`, true);
  if (!first || !Array.isArray(first.body)) return null;
  const pages = Number(first.headers.get('x-wp-totalpages') ?? 1);
  const items = [...first.body];
  for (let p = 2; p <= pages; p++) {
    await sleep(1000);
    const r = await get(`${SITE}/wp-json/wp/v2/model?per_page=100&page=${p}`, true);
    if (r && Array.isArray(r.body)) items.push(...r.body);
  }
  // Resolve taxonomy term ids to names.
  const terms = {};
  for (const tax of ['creator', 'difficulty', 'sheets', 'paper_shape', 'label']) {
    terms[tax] = {};
    for (let p = 1; p < 50; p++) {
      const r = await get(`${SITE}/wp-json/wp/v2/${tax}?per_page=100&page=${p}`, true);
      if (!r || !Array.isArray(r.body) || !r.body.length) break;
      for (const t of r.body) terms[tax][t.id] = decode(t.name);
      if (p >= Number(r.headers.get('x-wp-totalpages') ?? 1)) break;
      await sleep(500);
    }
  }
  const names = (item, tax) => (Array.isArray(item[tax]) ? item[tax].map((id) => terms[tax][id]).filter(Boolean) : []);
  return items.map((it) => ({
    url: it.link,
    title: decode(it.title?.rendered),
    creators: names(it, 'creator'),
    difficulty: names(it, 'difficulty')[0],
    sheets: names(it, 'sheets')[0],
    shape: names(it, 'paper_shape')[0],
    labels: names(it, 'label'),
  }));
}

async function fromPages() {
  const sm = await get(`${SITE}/wp-sitemap-posts-model-1.xml`);
  if (!sm) throw new Error('No model sitemap');
  const urls = [...sm.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const out = [];
  for (const url of urls) {
    await sleep(1000);
    const r = await get(url);
    if (!r) continue;
    const h = r.body;
    const title = decode((h.match(/<meta property="og:title" content="([^"]*)"/) ?? h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) ?? [])[1] ?? slug(url)).replace(/\s*[-|–]\s*Origami Database.*$/i, '');
    const terms = (tax) => [...h.matchAll(new RegExp(`href="${SITE}/${tax}/[^"]*"[^>]*>([^<]+)<`, 'g'))].map((m) => decode(m[1]));
    out.push({ url, title, creators: terms('creator'), difficulty: terms('difficulty')[0], sheets: terms('sheets')[0], shape: terms('paper_shape')[0], labels: terms('label') });
  }
  return out;
}

const raw = (await fromApi()) ?? (await fromPages());
const seen = new Set();
const entries = [];
for (const m of raw) {
  if (!m.url || !m.title) continue;
  let id = `odb-${slug(m.url)}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const sheets = Number.parseInt(m.sheets ?? '', 10);
  entries.push({
    id,
    kind: 'link',
    title: m.title,
    aliases: [],
    categories: categoriesOf(`${m.title} ${m.labels.join(' ')}`),
    tags: m.labels.map((l) => l.toLowerCase()).slice(0, 8),
    difficulty: difficultyOf(m.difficulty),
    description: '',
    designer: m.creators.join(', ') || 'Unknown',
    sheets: Number.isFinite(sheets) && sheets > 0 ? sheets : 1,
    paper: m.shape || undefined,
    url: m.url,
    source: 'Origami Database',
  });
}
entries.sort((a, b) => a.title.localeCompare(b.title));
fs.mkdirSync('data/catalog', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(entries, null, 1) + '\n');
console.log(`Wrote ${entries.length} entries to ${OUT}`);
