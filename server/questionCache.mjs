// server/questionCache.mjs — cache de questions générées (serveur).
//
// Réduit le coût et la latence LLM : un thème déjà traité ressort du pool sans
// rappeler le provider. Le cache est une Map en mémoire, persistée en JSON pour
// survivre aux redéploiements (le fichier vit à la racine du projet, hors du
// tar de déploiement qui ne contient que dist/ + server/).
//
// Clé de cache : `theme | difficulté | public | sourceKey`. L'`exclude` (questions
// déjà posées dans la session) n'entre PAS dans la clé : le pool est filtré par
// exclude à chaque lecture, ce qui permet de resservir les mêmes questions à une
// NOUVELLE session (historique vide) tout en évitant les doublons dans la même.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE_FILE = process.env.QUESTION_CACHE_FILE
  || join(dirname(fileURLToPath(import.meta.url)), '..', '.question-cache.json');

// key -> questions[]
const pools = new Map();

function normalize(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Clé stable : les dimensions qui font varier le contenu des questions. */
export function computeKey({ theme, difficulty, audience, sourceKey }) {
  return [theme, difficulty, audience, sourceKey || ''].map(normalize).join('|');
}

/** Questions du pool non exclues, jusqu'à `limit` (batch du client). */
export function getNonExcluded(key, exclude, limit) {
  const pool = pools.get(key) || [];
  const excluded = new Set((exclude || []).map(normalize));
  const out = [];
  for (const q of pool) {
    if (excluded.has(normalize(q.question))) continue;
    out.push(q);
    if (limit && out.length >= limit) break;
  }
  return out;
}

/** Ajoute des questions au pool (dédupliquées), puis persiste. */
export function addQuestions(key, questions) {
  if (!Array.isArray(questions) || !questions.length) return;
  let pool = pools.get(key);
  if (!pool) {
    pool = [];
    pools.set(key, pool);
  }
  const seen = new Set(pool.map(q => normalize(q.question)));
  let changed = false;
  for (const q of questions) {
    // Garde minimale : ne cacher que des questions structurellement complètes.
    // Sinon une question invalide (rejetée par le client) serait resservie en boucle.
    if (!q || typeof q.question !== 'string' || !Array.isArray(q.options) || q.options.length !== 4) continue;
    const n = normalize(q.question);
    if (seen.has(n)) continue;
    seen.add(n);
    pool.push(q);
    changed = true;
  }
  if (changed) persist();
}

/**
 * Extrait la liste `questions` d'une réponse LLM (chaîne JSON éventuellement
 * entourée de texte/fences). Simplifié par rapport au client : en cas d'échec on
 * ne met simplement rien en cache — jamais d'erreur remontée.
 */
export function extractQuestions(content) {
  if (typeof content !== 'string') return [];
  try {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end <= start) return [];
    const json = JSON.parse(content.slice(start, end + 1));
    return Array.isArray(json?.questions) ? json.questions : [];
  } catch {
    return [];
  }
}

/** Statistiques d'observation (exposées par /api/relay/health). */
export function stats() {
  let questions = 0;
  for (const pool of pools.values()) questions += pool.length;
  return { keys: pools.size, questions };
}

function persist() {
  try {
    const data = {};
    for (const [key, pool] of pools) data[key] = pool;
    writeFileSync(CACHE_FILE, JSON.stringify(data));
  } catch (err) {
    console.error('[question-cache] écriture impossible :', err.message);
  }
}

/** Charge le cache depuis le disque (appelé au démarrage du serveur). */
export function load() {
  try {
    if (!existsSync(CACHE_FILE)) return;
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    for (const [key, pool] of Object.entries(data)) {
      if (Array.isArray(pool)) pools.set(key, pool);
    }
    const s = stats();
    console.log(`[question-cache] ${s.questions} question(s) chargée(s), ${s.keys} clé(s)`);
  } catch (err) {
    console.error('[question-cache] lecture impossible :', err.message);
  }
}
