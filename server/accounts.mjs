// server/accounts.mjs — comptes Google + crédits de parties (serveur, SQLite).
//
// Le mode « payant » : pour utiliser la clé LLM du serveur (plutôt que sa propre
// clé BYOK), le créateur de partie doit avoir un compte (connexion Google) et des
// crédits. Ce module est la source de vérité de ce comptage — le navigateur ne
// fait que demander, le serveur décide.
//
//   - 3 parties gratuites par mois calendaire (UTC) ;
//   - pack payant : PACK_PRICE_CENTS → PACK_CREDITS parties, ponctuel, sans
//     expiration (crédité par le webhook Stripe) ;
//   - chaque partie consommée rend un `gameToken` éphémère (24 h) que le client
//     joint à ses appels /api/chat/completions : c'est lui qui prouve qu'un crédit
//     a bien été dépensé pour la partie en cours.
//
// Base dédiée `.accounts.db` (persistante, hors du tar de déploiement), comme le
// cache de questions. Zéro dépendance : SQLite natif `node:sqlite`.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_FILE = process.env.ACCOUNTS_DB
  || join(dirname(fileURLToPath(import.meta.url)), '..', '.accounts.db');

function intEnv(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

export const FREE_GAMES_PER_MONTH = intEnv('FREE_GAMES_PER_MONTH', 3);
export const PACK_PRICE_CENTS = intEnv('PACK_PRICE_CENTS', 200); // 2,00 € / $
export const PACK_CREDITS = intEnv('PACK_CREDITS', 20);

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // session : 30 jours
const GAME_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;   // partie : 24 h max

let db = null;

/** Clé de période mensuelle « YYYY-MM » (UTC) — la fenêtre des parties gratuites. */
export function periodKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 7);
}

function ensureDb() {
  if (db) return db;
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      google_sub  TEXT NOT NULL UNIQUE,
      email       TEXT NOT NULL,
      name        TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token       TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS monthly_usage (
      user_id     INTEGER NOT NULL,
      period_key  TEXT NOT NULL,
      used        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, period_key)
    );
    CREATE TABLE IF NOT EXISTS purchased_credits (
      user_id     INTEGER PRIMARY KEY,
      remaining   INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS game_tokens (
      token       TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS purchases (
      stripe_session_id  TEXT PRIMARY KEY,
      user_id            INTEGER NOT NULL,
      credits            INTEGER NOT NULL,
      created_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_game_tokens_user ON game_tokens(user_id);
  `);
  return db;
}

// --- Comptes ---

export function getOrCreateUser({ sub, email, name }) {
  const d = ensureDb();
  const existing = d.prepare('SELECT id FROM users WHERE google_sub = ?').get(sub);
  if (existing) {
    d.prepare('UPDATE users SET email = ?, name = ? WHERE id = ?').run(email, name, existing.id);
    return existing.id;
  }
  const info = d.prepare(
    'INSERT INTO users (google_sub, email, name, created_at) VALUES (?, ?, ?, ?)',
  ).run(sub, email, name, Date.now());
  return Number(info.lastInsertRowid);
}

// --- Sessions d'authentification ---

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  ensureDb().prepare(
    'INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(token, userId, now, now + SESSION_TTL_MS);
  return token;
}

export function getUserBySession(token) {
  if (!token) return null;
  const d = ensureDb();
  const row = d.prepare(
    'SELECT u.id, u.email, u.name FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?',
  ).get(token, Date.now());
  return row ?? null;
}

export function deleteSession(token) {
  if (!token) return;
  ensureDb().prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
}

// --- Crédits ---

/** État du compte : parties gratuites restantes ce mois-ci + crédits achetés. */
export function accountSummary(userId) {
  const d = ensureDb();
  const user = d.prepare('SELECT id, email, name FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const pc = d.prepare('SELECT remaining FROM purchased_credits WHERE user_id = ?').get(userId);
  const usage = d.prepare(
    'SELECT used FROM monthly_usage WHERE user_id = ? AND period_key = ?',
  ).get(userId, periodKey());
  const freeRemaining = Math.max(0, FREE_GAMES_PER_MONTH - (usage?.used ?? 0));
  return {
    signedIn: true,
    email: user.email,
    name: user.name,
    freeRemaining,
    purchasedRemaining: pc?.remaining ?? 0,
    freeGamesPerMonth: FREE_GAMES_PER_MONTH,
    packPriceCents: PACK_PRICE_CENTS,
    packCredits: PACK_CREDITS,
  };
}

/**
 * Consomme un crédit : acheté d'abord (il n'expire pas), puis gratuit du mois.
 * Rend `{ gameToken, source }` ou `null` si plus aucun crédit.
 */
export function consumeGame(userId) {
  const d = ensureDb();
  const now = Date.now();
  d.exec('BEGIN');
  try {
    let source = null;
    const pc = d.prepare('SELECT remaining FROM purchased_credits WHERE user_id = ?').get(userId);
    if (pc && pc.remaining > 0) {
      d.prepare('UPDATE purchased_credits SET remaining = remaining - 1 WHERE user_id = ?').run(userId);
      source = 'purchased';
    } else {
      const key = periodKey(now);
      const usage = d.prepare(
        'SELECT used FROM monthly_usage WHERE user_id = ? AND period_key = ?',
      ).get(userId, key);
      if ((usage?.used ?? 0) < FREE_GAMES_PER_MONTH) {
        d.prepare(
          'INSERT INTO monthly_usage (user_id, period_key, used) VALUES (?, ?, 1) ON CONFLICT(user_id, period_key) DO UPDATE SET used = used + 1',
        ).run(userId, key);
        source = 'free';
      }
    }
    if (!source) {
      d.exec('ROLLBACK');
      return null;
    }
    const token = randomBytes(24).toString('hex');
    d.prepare(
      'INSERT INTO game_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).run(token, userId, now, now + GAME_TOKEN_TTL_MS);
    d.exec('COMMIT');
    return { gameToken: token, source };
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/** Compte propriétaire d'un game token valide, ou `null`. */
export function getGameTokenOwner(token) {
  if (!token) return null;
  const d = ensureDb();
  const row = d.prepare('SELECT user_id, expires_at FROM game_tokens WHERE token = ?').get(token);
  if (!row || row.expires_at < Date.now()) return null;
  return row.user_id;
}

/** Libère un game token (fin de partie). Best-effort. */
export function endGame(token) {
  if (!token) return;
  ensureDb().prepare('DELETE FROM game_tokens WHERE token = ?').run(token);
}

/**
 * Crédite un achat Stripe. Idempotent : un même `checkout.session.id` ne crédite
 * qu'une fois. Rend `true` si le crédit a réellement été appliqué.
 */
export function creditPurchase(userId, stripeSessionId, credits) {
  const d = ensureDb();
  d.exec('BEGIN');
  try {
    const ins = d.prepare(
      'INSERT OR IGNORE INTO purchases (stripe_session_id, user_id, credits, created_at) VALUES (?, ?, ?, ?)',
    ).run(stripeSessionId, userId, credits, Date.now());
    if (ins.changes > 0) {
      d.prepare(
        'INSERT INTO purchased_credits (user_id, remaining) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET remaining = purchased_credits.remaining + excluded.remaining',
      ).run(userId, credits);
    }
    d.exec('COMMIT');
    return ins.changes > 0;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/** Nettoie les sessions et game tokens expirés (pas de fuite en base). */
function cleanup() {
  const d = ensureDb();
  const now = Date.now();
  d.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
  d.prepare('DELETE FROM game_tokens WHERE expires_at <= ?').run(now);
}

/** Ouvre la base (création des tables si besoin). Appelé au démarrage. */
export function load() {
  ensureDb();
  cleanup();
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  console.log(`[accounts] SQLite prêt : ${users} compte(s)`);
}

// Nettoyage périodique, non bloquant pour l'arrêt du processus.
setInterval(cleanup, 60 * 60 * 1000).unref();
