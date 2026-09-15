// storage.js — wrappers localStorage typés avec parse défensif.
import {
  STORAGE_KEYS, PLAYER_EMOJIS, DIFFICULTY_CHOICES, AUDIENCE_CHOICES,
  TIMER_CHOICES, PUNISHER_CHOICES, MANCHE_CHOICES,
} from './constants.js';

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
      emoji: typeof p.emoji === 'string' ? p.emoji : PLAYER_EMOJIS[0],
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

  // Règles de partie. Chaque valeur est revalidée contre la liste de choix :
  // un localStorage bricolé à la main ne doit pas injecter n'importe quoi.
  out.timerEnabled = !!raw.timerEnabled;
  if (TIMER_CHOICES.some(c => c.value === raw.timePerQuestion)) {
    out.timePerQuestion = raw.timePerQuestion;
  }
  out.penaltyNoAnswer = !!raw.penaltyNoAnswer;
  out.penaltyWrongAnswer = !!raw.penaltyWrongAnswer;
  if (PUNISHER_CHOICES.some(c => c.value === raw.punisherSeverity)) {
    out.punisherSeverity = raw.punisherSeverity;
  }
  if (MANCHE_CHOICES.some(c => c.value === raw.manchesTarget)) {
    out.manchesTarget = raw.manchesTarget;
  }

  // Mode de jeu. Simple identifiant : on ne peut pas vérifier ici qu'il existe
  // encore, le catalogue vit en IndexedDB et se lit de façon asynchrone. Le
  // sélecteur retombe sur « personnalisé » s'il ne le retrouve pas.
  if (typeof raw.modeId === 'string' && /^[\w-]{1,60}$/.test(raw.modeId)) {
    out.modeId = raw.modeId;
  }

  // Source Wikipédia : seuls les identifiants sont persistés, jamais le texte
  // de l'article — saveSettings est appelé à chaque dispatch.
  if (raw.sourceMode === 'wikipedia' || raw.sourceMode === 'theme') {
    out.sourceMode = raw.sourceMode;
  }
  if (typeof raw.sourceTitle === 'string') out.sourceTitle = raw.sourceTitle.slice(0, 200);
  if (typeof raw.sourceLang === 'string' && /^[a-z-]{2,12}$/.test(raw.sourceLang)) {
    out.sourceLang = raw.sourceLang;
  }
  if (typeof raw.sourceUrl === 'string') out.sourceUrl = raw.sourceUrl.slice(0, 500);

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
    timerEnabled: settings.timerEnabled,
    timePerQuestion: settings.timePerQuestion,
    penaltyNoAnswer: settings.penaltyNoAnswer,
    penaltyWrongAnswer: settings.penaltyWrongAnswer,
    punisherSeverity: settings.punisherSeverity,
    manchesTarget: settings.manchesTarget,
    modeId: settings.modeId,
    sourceMode: settings.sourceMode,
    sourceTitle: settings.sourceTitle,
    sourceLang: settings.sourceLang,
    sourceUrl: settings.sourceUrl,
  });
}

// --- Configuration LLM ---
// Clé distincte de celle des réglages de jeu : elle est globale à l'appareil et
// n'a rien à faire dans un instantané de partie.

function sanitizeLlm(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (typeof raw.model === 'string' && raw.model.trim()) out.model = raw.model.slice(0, 120);
  if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) out.baseUrl = raw.baseUrl.slice(0, 300);
  if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) out.apiKey = raw.apiKey.slice(0, 300);
  if (Number.isFinite(raw.temperature)) out.temperature = Math.min(2, Math.max(0, raw.temperature));
  if (Number.isFinite(raw.batchSize)) out.batchSize = Math.min(20, Math.max(1, Math.round(raw.batchSize)));
  return out;
}

/**
 * Récupère la configuration LLM depuis les réglages de jeu, où elle vivait
 * avant d'avoir sa propre clé. Sans cela, tout appareil déjà utilisé perd sa
 * clé API au premier chargement de cette version et doit la resaisir.
 *
 * Les champs sont retirés du blob de réglages dans la foulée : une clé API n'a
 * rien à faire dans une entrée que `persistResume` recopie en entier.
 */
function migrateLlmFromSettings() {
  const raw = readJson(STORAGE_KEYS.settings, null);
  const migrated = sanitizeLlm(raw);
  if (!migrated || !Object.keys(migrated).length) return null;

  for (const k of ['model', 'baseUrl', 'apiKey', 'temperature', 'batchSize']) delete raw[k];
  writeJson(STORAGE_KEYS.settings, raw);
  writeJson(STORAGE_KEYS.llm, migrated);
  return migrated;
}

export function loadLlmConfig() {
  const stored = readJson(STORAGE_KEYS.llm, null);
  if (!stored) return migrateLlmFromSettings();
  return sanitizeLlm(stored);
}

export function saveLlmConfig(llm) {
  writeJson(STORAGE_KEYS.llm, {
    model: llm.model, baseUrl: llm.baseUrl, apiKey: llm.apiKey,
    temperature: llm.temperature, batchSize: llm.batchSize,
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

/**
 * Remise à zéro de la soirée : joueurs, réglages, stats, session active.
 *
 * La configuration LLM est volontairement épargnée. Elle est globale à
 * l'appareil et coûte une resaisie de clé API, alors que ce bouton sert à
 * repartir d'une feuille blanche entre deux parties. Pour tout effacer, y
 * compris les identifiants, c'est `wipeLocalStorage()` (écran Paramètres).
 */
export function clearAll() {
  Object.entries(STORAGE_KEYS).forEach(([name, k]) => {
    if (name === 'llm') return;
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  });
}

/**
 * Efface TOUTES les clés de l'application dans localStorage.
 *
 * Balayage par préfixe et non liste figée : `clearAll()` s'appuie sur
 * STORAGE_KEYS, qui ne contient pas la clé du thème — celle-ci vit dans
 * themeSwitcher.js et survivait donc à une « remise à zéro ». Le préfixe évite
 * aussi de toucher une éventuelle autre application servie sur la même origine,
 * ce qu'un `localStorage.clear()` ferait.
 *
 * @returns {number} nombre de clés supprimées
 */
export function wipeLocalStorage() {
  const PREFIX = 'quizz-canape:';
  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(PREFIX));
    for (const k of keys) localStorage.removeItem(k);
    return keys.length;
  } catch { return 0; }
}
