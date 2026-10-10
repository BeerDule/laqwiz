// server/questionCache.mjs — cache de questions générées (serveur, SQLite).
//
// Réduit le coût et la latence LLM : un thème déjà traité ressort du pool sans
// rappeler le provider. Le pool vit dans une base SQLite (module natif
// `node:sqlite`, zéro dépendance npm) persistée à la racine du projet — hors du
// tar de déploiement qui ne contient que dist/ + server/.
//
// Clé de cache : `theme | public | sourceKey` — la difficulté n'entre PAS dans la
// clé : elle est stockée par question (easy/medium/hard) et filtrée à la lecture.
// « équilibré » (balanced) pioche donc dans les trois difficultés ; « easy »,
// « medium » ou « hard » restreignent à une seule. L'`exclude` (questions déjà
// posées) est filtré à chaque lecture, pour resservir à une NOUVELLE session tout
// en évitant les doublons dans la même.
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_FILE = process.env.QUESTION_CACHE_DB
  || join(dirname(fileURLToPath(import.meta.url)), '..', '.question-cache.db');

const DIFFICULTIES = ['easy', 'medium', 'hard'];

let db = null;

function normalize(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Clé stable : les dimensions qui font varier le contenu des questions. */
export function computeKey({ theme, audience, sourceKey }) {
  return [theme, audience, sourceKey || ''].map(normalize).join('|');
}

/** Difficultés servies pour un réglage donné : « balanced » → les trois. */
function difficultyFilter(difficulty) {
  const d = normalize(difficulty);
  if (DIFFICULTIES.includes(d)) return [d];
  return DIFFICULTIES;
}

function ensureDb() {
  if (db) return db;
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS questions (
      cache_key   TEXT NOT NULL,
      theme       TEXT NOT NULL,
      difficulty  TEXT NOT NULL,
      question_text TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(cache_key, question_text)
    );
    CREATE INDEX IF NOT EXISTS idx_questions_cache_key ON questions(cache_key, difficulty);
    CREATE INDEX IF NOT EXISTS idx_questions_theme ON questions(theme);
  `);
  return db;
}

/** Questions du pool non exclues, filtrées par difficulté, jusqu'à `limit`. */
export function getNonExcluded(key, difficulty, exclude, limit) {
  const d = ensureDb();
  const filter = difficultyFilter(difficulty);
  const excluded = (exclude || []).map(normalize);
  let sql = 'SELECT payload FROM questions WHERE cache_key = ?';
  const params = [key];
  if (filter.length === 1) {
    sql += ' AND difficulty = ?';
    params.push(filter[0]);
  }
  if (excluded.length) {
    sql += ` AND question_text NOT IN (${excluded.map(() => '?').join(',')})`;
    params.push(...excluded);
  }
  sql += ' ORDER BY created_at ASC LIMIT ?';
  params.push(Number(limit) || 8);
  return d.prepare(sql).all(...params).map((r) => JSON.parse(r.payload));
}

/** Ajoute des questions au pool (dédupliquées par texte). Retourne le nb inséré. */
export function addQuestions(quiz, questions) {
  if (!Array.isArray(questions) || !questions.length) return 0;
  const d = ensureDb();
  const key = computeKey(quiz);
  const theme = String(quiz.theme || '');
  const stmt = d.prepare(
    'INSERT OR IGNORE INTO questions (cache_key, theme, difficulty, question_text, payload) VALUES (?, ?, ?, ?, ?)',
  );
  let inserted = 0;
  for (const q of questions) {
    // Garde minimale : ne cacher que des questions structurellement complètes.
    if (!q || typeof q.question !== 'string' || !Array.isArray(q.options) || q.options.length !== 4) continue;
    const diff = DIFFICULTIES.includes(normalize(q.difficulty)) ? normalize(q.difficulty) : 'medium';
    inserted += stmt.run(key, theme, diff, normalize(q.question), JSON.stringify(q)).changes;
  }
  return inserted;
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

/** Thèmes en cache, avec leur compte par difficulté (triés). */
export function listThemes() {
  const d = ensureDb();
  const rows = d.prepare(
    'SELECT theme, difficulty, COUNT(*) AS count FROM questions GROUP BY theme, difficulty ORDER BY theme COLLATE NOCASE, difficulty',
  ).all();
  const byTheme = new Map();
  for (const r of rows) {
    if (!byTheme.has(r.theme)) byTheme.set(r.theme, { theme: r.theme, easy: 0, medium: 0, hard: 0 });
    const t = byTheme.get(r.theme);
    if (r.difficulty === 'easy') t.easy = r.count;
    else if (r.difficulty === 'medium') t.medium = r.count;
    else if (r.difficulty === 'hard') t.hard = r.count;
  }
  return [...byTheme.values()];
}

/** Statistiques d'observation (exposées par /api/relay/health). */
export function stats() {
  const d = ensureDb();
  const { n } = d.prepare('SELECT COUNT(*) AS n FROM questions').get();
  const { k } = d.prepare('SELECT COUNT(DISTINCT cache_key) AS k FROM questions').get();
  return { keys: k, questions: n };
}

/** Ouvre la base (création des tables si besoin). Appelé au démarrage. */
export function load() {
  ensureDb();
  const s = stats();
  console.log(`[question-cache] SQLite prêt : ${s.questions} question(s), ${s.keys} clé(s)`);
}
