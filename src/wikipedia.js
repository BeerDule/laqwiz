// wikipedia.js — recherche d'articles et extraction de leur texte.
//
// Les APIs MediaWiki renvoient `Access-Control-Allow-Origin: *` dès qu'on passe
// `origin=*` : le navigateur les appelle donc directement, sans passer par le
// proxy LLM. Rien à ajouter dans vite.config.js ni api/gateway.js.

const DEFAULT_LANG = 'fr';
const TIMEOUT_MS = 12_000;

// Sections de queue : elles ne contiennent que des renvois, aucune matière à
// question. Comparées en minuscules et sans accents.
const TAIL_SECTIONS = [
  'notes et references', 'references', 'notes', 'voir aussi', 'annexes',
  'bibliographie', 'articles connexes', 'liens externes', 'sources',
  'filmographie', 'emission', 'emissions', 'discographie', 'publications',
  'see also', 'references and notes', 'external links', 'further reading',
];

const MIN_SECTION_CHARS = 120;  // en dessous, ce n'est qu'un titre
const MAX_SECTION_CHARS = 2400; // au-delà, on redécoupe : voir splitSections

function deburr(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function apiUrl(lang, params) {
  const qs = new URLSearchParams({ format: 'json', origin: '*', ...params });
  return `https://${lang}.wikipedia.org/w/api.php?${qs}`;
}

async function getJson(url) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Wikipédia a répondu ${res.status}.`);
    return await res.json();
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Reconnaît une URL d'article collée par le MJ, pour éviter de la relancer
 * bêtement dans la recherche. Renvoie { lang, title } ou null.
 */
export function parseArticleUrl(input) {
  try {
    const url = new URL(input.trim());
    const m = url.hostname.match(/^([a-z-]+)\.(m\.)?wikipedia\.org$/i);
    if (!m) return null;
    const path = decodeURIComponent(url.pathname);
    const title = path.startsWith('/wiki/')
      ? path.slice(6)
      : new URLSearchParams(url.search).get('title');
    if (!title) return null;
    return { lang: m[1].toLowerCase(), title: title.replace(/_/g, ' ') };
  } catch { return null; }
}

/**
 * Suggestions d'articles (API opensearch).
 * Renvoie [{ title, url }].
 */
export async function searchArticles(query, lang = DEFAULT_LANG) {
  const q = query.trim();
  if (q.length < 2) return [];
  const data = await getJson(apiUrl(lang, {
    action: 'opensearch', limit: '8', namespace: '0', search: q,
  }));
  const [, titles = [], , urls = []] = data;
  return titles.map((title, i) => ({ title, url: urls[i] || '' }));
}

/**
 * Découpe l'extrait brut en sections exploitables.
 * L'API `explaintext` conserve les titres sous la forme `== Titre ==`.
 */
function splitSections(extract) {
  const parts = extract.split(/\n(?==+ .+ =+\n)/);
  const out = [];
  for (const part of parts) {
    const m = part.match(/^=+ (.+?) =+\n?/);
    const title = m ? m[1].trim() : 'Introduction';
    const body = (m ? part.slice(m[0].length) : part).trim();
    if (body.length < MIN_SECTION_CHARS) continue;      // titre sans contenu
    if (TAIL_SECTIONS.includes(deburr(title))) continue; // renvois, pas de matière
    for (const chunk of chunkBody(body)) out.push({ title, body: chunk });
  }
  return out;
}

/**
 * Redécoupe un corps trop long aux frontières de paragraphe. Sans ça, une seule
 * section volumineuse ferait exploser le budget d'une fenêtre — et la tronquer
 * rendrait sa fin définitivement inatteignable.
 */
function chunkBody(body) {
  if (body.length <= MAX_SECTION_CHARS) return [body];
  const chunks = [];
  let current = '';
  for (const para of body.split('\n')) {
    if (current && current.length + para.length + 1 > MAX_SECTION_CHARS) {
      chunks.push(current);
      current = '';
    }
    // Un paragraphe seul peut encore dépasser : on le coupe au mot près.
    if (para.length > MAX_SECTION_CHARS) {
      let rest = para;
      while (rest.length > MAX_SECTION_CHARS) {
        const cut = rest.lastIndexOf(' ', MAX_SECTION_CHARS);
        chunks.push(rest.slice(0, cut > 0 ? cut : MAX_SECTION_CHARS));
        rest = rest.slice(cut > 0 ? cut + 1 : MAX_SECTION_CHARS);
      }
      current = rest;
      continue;
    }
    current = current ? `${current}\n${para}` : para;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Télécharge un article et le prépare pour la génération.
 * Renvoie { lang, title, url, sections: [{title, body}] }.
 */
export async function fetchArticle(title, lang = DEFAULT_LANG) {
  const data = await getJson(apiUrl(lang, {
    action: 'query', prop: 'extracts', explaintext: '1', redirects: '1',
    titles: title,
  }));
  const pages = data?.query?.pages || {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined || !page.extract) {
    throw new Error('Article introuvable sur Wikipédia.');
  }
  const sections = splitSections(page.extract);
  if (!sections.length) {
    throw new Error('Cet article est trop court pour en tirer des questions.');
  }
  return {
    lang,
    title: page.title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    sections,
  };
}

/**
 * Fenêtre glissante : renvoie assez de sections pour remplir `budget`
 * caractères, en repartant de `cursor`. Renvoie aussi le curseur suivant et
 * `wrapped` — vrai quand on a rebouclé, c'est-à-dire que tout l'article a
 * déjà servi au moins une fois.
 */
export function sectionWindow(sections, cursor = 0, budget = 3500) {
  if (!sections.length) return { text: '', nextCursor: 0, wrapped: true };
  const picked = [];
  let size = 0;
  let i = cursor % sections.length;
  let wrapped = false;
  for (let n = 0; n < sections.length; n++) {
    const s = sections[i];
    if (picked.length && size + s.body.length > budget) break;
    picked.push(s);
    size += s.body.length;
    i = (i + 1) % sections.length;
    if (i === 0) wrapped = true;
    if (size >= budget) break;
  }
  const text = picked.map(s => `## ${s.title}\n${s.body}`).join('\n\n');
  return { text, nextCursor: i, wrapped };
}
