// storage.js — wrappers localStorage typés avec parse défensif.
import { STORAGE_KEYS, DIFFICULTY_CHOICES, AUDIENCE_CHOICES } from './constants.js';

export function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`[storage] valeur ignorée pour ${key}`, error);
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    return fallback;
  }
}

export function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn('[storage] écriture impossible', error);
  }
}

// --- Joueurs ---

export function loadPlayers() {
  const raw = readJson(STORAGE_KEYS.players, null);
  if (!Array.isArray(raw)) return null;
  const valid = raw
    .filter(p => p && typeof p.id === 'string' && typeof p.name === 'string')
    .map(p => ({
      id: p.id,
      name: p.name,
      emoji: typeof p.emoji === 'string' ? p.emoji : '😀',
      color: typeof p.color === 'string' ? p.color : '#a855f7',
    }));
  return valid.length ? valid : null;
}

export function savePlayers(players) {
  writeJson(STORAGE_KEYS.players, players.map(({ id, name, emoji, color }) => ({
    id, name, emoji, color,
  })));
}

// --- Settings ---

export function loadSettings() {
  const raw = readJson(STORAGE_KEYS.settings, null);
  if (!raw || typeof raw !== 'object') return null;

  const out = {};
  if (typeof raw.theme === 'string' && raw.theme.trim()) {
    out.theme = raw.theme.slice(0, 60);
  }
  if (typeof raw.targetScore === 'number' && Number.isFinite(raw.targetScore)) {
    out.targetScore = Math.min(30, Math.max(5, Math.round(raw.targetScore)));
  }
  out.twoPointLead = !!raw.twoPointLead;
  out.bonusEnabled = !!raw.bonusEnabled;
  if (DIFFICULTY_CHOICES.some(c => c.value === raw.difficulty)) {
    out.difficulty = raw.difficulty;
  }
  if (AUDIENCE_CHOICES.some(c => c.value === raw.audience)) {
    out.audience = raw.audience;
  }
  // Config LLM personnelle (BYOK) : lue depuis localStorage.
  if (typeof raw.model === 'string' && raw.model.trim()) {
    out.model = raw.model.slice(0, 120);
  }
  if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) {
    out.baseUrl = raw.baseUrl.slice(0, 300);
  }
  if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) {
    out.apiKey = raw.apiKey.slice(0, 300);
  }
  return out;
}

export function saveSettings(settings) {
  writeJson(STORAGE_KEYS.settings, {
    theme: settings.theme,
    targetScore: settings.targetScore,
    twoPointLead: settings.twoPointLead,
    bonusEnabled: settings.bonusEnabled,
    difficulty: settings.difficulty,
    audience: settings.audience,
    model: settings.model,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
  });
}

// --- Stats ---

export function loadStats() {
  const raw = readJson(STORAGE_KEYS.stats, null);
  if (!raw || typeof raw !== 'object') {
    return { gamesPlayed: 0, questionsAnswered: 0, correctAnswers: 0, perPlayer: {} };
  }
  return {
    gamesPlayed: Number.isFinite(raw.gamesPlayed) ? raw.gamesPlayed : 0,
    questionsAnswered: Number.isFinite(raw.questionsAnswered) ? raw.questionsAnswered : 0,
    correctAnswers: Number.isFinite(raw.correctAnswers) ? raw.correctAnswers : 0,
    perPlayer: (raw.perPlayer && typeof raw.perPlayer === 'object') ? raw.perPlayer : {},
  };
}

export function saveStats(stats) {
  writeJson(STORAGE_KEYS.stats, stats);
}

// --- Session active ---
// Seul l'identifiant vit en localStorage : il doit être lu de façon synchrone
// au démarrage pour savoir quelle session recharger. Le contenu, lui, est en
// IndexedDB (voir db.js).

export function loadActiveSessionId() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.activeSession);
    return typeof raw === 'string' && raw ? raw : null;
  } catch { return null; }
}

export function saveActiveSessionId(id) {
  try {
    if (id) localStorage.setItem(STORAGE_KEYS.activeSession, id);
    else localStorage.removeItem(STORAGE_KEYS.activeSession);
  } catch { /* quota exceeded */ }
}

export function clearAll() {
  Object.values(STORAGE_KEYS).forEach(k => {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  });
}
