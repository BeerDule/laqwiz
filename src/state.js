// state.js — source de vérité de l'application (SPEC §9, §10, §11).
import { normalizeQuestionText } from './validation.js';
import { fetchQuestionBatch, toUiError } from './api.js';
import { saveStats, clearAll } from './storage.js';
import { DEFAULTS, BONUS_CHANCE, BATCH_SIZE } from './constants.js';

const isOnline = () => (typeof navigator !== 'undefined' ? navigator.onLine : true);

/**
 * État global unique de l'application.
 * Immutable côté consommateurs : seul `dispatch(action)` peut le modifier.
 */
const INITIAL_STATE = Object.freeze({
  // === Joueurs ===
  players: [
    // { id: 'p1', name: 'Alice', emoji: '🦊', color: '#a855f7', score: 0 }
  ],

  // === Paramètres (modifiables à SETUP, snapshotés au début de partie) ===
  settings: {
    theme: DEFAULTS.theme,
    targetScore: DEFAULTS.targetScore,
    twoPointLead: DEFAULTS.twoPointLead,
    bonusEnabled: DEFAULTS.bonusEnabled,
    model: DEFAULTS.model,
    temperature: DEFAULTS.temperature,
    batchSize: DEFAULTS.batchSize,
  },

  // === Questions ===
  questions: [],
  currentIndex: -1,

  // === Saisie MJ sur la question courante ===
  roundAnswers: {},
  isBonusRound: false,

  // === Phase courante ===
  phase: 'SETUP', // 'SETUP' | 'LOADING' | 'QUESTION' | 'REVEAL' | 'VICTORY'

  // === File de préchargement ===
  prefetchQueue: [],
  prefetchInflight: false,

  // === Historique anti-doublon ===
  history: [],

  // === Statistiques persistantes ===
  stats: {
    gamesPlayed: 0,
    questionsAnswered: 0,
    correctAnswers: 0,
    perPlayer: {},
  },

  // === UI transient ===
  ui: {
    lastError: null,
    isOnline: isOnline(),
    isFetching: false,
  },
});

const state = structuredClone(INITIAL_STATE);
const subscribers = new Set();

export function getState() {
  return state;
}

export function subscribe(fn) {
  subscribers.add(fn);
  try { fn(state); } catch (e) { console.error('[state] subscriber error', e); }
  return () => subscribers.delete(fn);
}

function notify() {
  for (const fn of subscribers) {
    try { fn(state); }
    catch (e) { console.error('[state] subscriber error', e); }
  }
}

export function dispatch(action) {
  reducer(state, action);
  notify();
}

function initPerPlayer(p) {
  return { name: p.name, emoji: p.emoji, gamesPlayed: 0, wins: 0, totalScore: 0 };
}

/**
 * Condition de victoire (SPEC §10.3).
 */
export function hasVictory(s) {
  const target = s.settings.targetScore;
  const ranked = [...s.players].sort((a, b) => b.score - a.score);
  const leader = ranked[0];
  const second = ranked[1];
  if (!leader || leader.score < target) return false;
  if (!s.settings.twoPointLead) return true;
  return !second || leader.score - second.score >= 2;
}

/**
 * Détermine un gagnant (SPEC §10.4).
 */
export function computeWinner(s) {
  const ranked = [...s.players].sort((a, b) => {
    const scoreDelta = b.score - a.score;
    if (scoreDelta !== 0) return scoreDelta;
    return s.players.indexOf(a) - s.players.indexOf(b);
  });
  return hasVictory(s) ? ranked[0] : null;
}

function reducer(s, action) {
  switch (action.type) {
    case 'SET_PLAYERS':
      s.players = action.players.map(p => ({ ...p, score: 0 }));
      break;

    case 'UPDATE_PLAYER': {
      const idx = s.players.findIndex(p => p.id === action.id);
      if (idx >= 0) s.players[idx] = { ...s.players[idx], ...action.patch };
      break;
    }

    case 'REMOVE_PLAYER':
      s.players = s.players.filter(p => p.id !== action.id);
      break;

    case 'SET_SETTINGS':
      s.settings = { ...s.settings, ...action.patch };
      break;

    case 'START_GAME':
      s.settings = { ...s.settings }; // snapshot
      s.questions = [];
      s.prefetchQueue = [];
      s.prefetchInflight = false;
      s.currentIndex = -1;
      s.roundAnswers = {};
      s.isBonusRound = false;
      s.phase = 'LOADING';
      s.history = action.resetHistory ? [] : s.history;
      triggerInitialBatch();
      break;

    case 'BATCH_RECEIVED':
      s.prefetchQueue.push(...action.questions);
      s.prefetchInflight = false;
      if (s.phase === 'LOADING' && s.prefetchQueue.length > 0) {
        s.phase = 'QUESTION';
        s.currentIndex = -1;
      }
      break;

    case 'SHOW_NEXT_QUESTION': {
      if (s.prefetchQueue.length === 0) return;
      const next = s.prefetchQueue.shift();
      s.questions.push(next);
      s.currentIndex = s.questions.length - 1;
      s.history.push(normalizeQuestionText(next.question));
      s.roundAnswers = Object.fromEntries(s.players.map(p => [p.id, null]));
      s.isBonusRound = s.settings.bonusEnabled && Math.random() < BONUS_CHANCE;
      s.phase = 'QUESTION';
      maybePrefetchNext();
      break;
    }

    case 'PLAYER_ANSWER':
      s.roundAnswers[action.playerId] = action.optionKey;
      break;

    case 'CLEAR_PLAYER_ANSWER':
      delete s.roundAnswers[action.playerId];
      break;

    case 'REVEAL_ANSWER': {
      s.phase = 'REVEAL';
      const q = s.questions[s.currentIndex];
      const correctKey = q.answer;
      const bonusMult = s.isBonusRound ? 2 : 1;
      let correctCount = 0;
      for (const p of s.players) {
        const ans = s.roundAnswers[p.id];
        if (ans === correctKey) {
          p.score += bonusMult;
          correctCount++;
          s.stats.perPlayer[p.id] = s.stats.perPlayer[p.id] || initPerPlayer(p);
          s.stats.perPlayer[p.id].totalScore += bonusMult;
        }
      }
      s.stats.questionsAnswered += s.players.length;
      s.stats.correctAnswers += correctCount;
      break;
    }

    case 'GOTO_VICTORY': {
      s.phase = 'VICTORY';
      const winner = computeWinner(s);
      if (winner) {
        s.stats.perPlayer[winner.id] = s.stats.perPlayer[winner.id] || initPerPlayer(winner);
        s.stats.perPlayer[winner.id].wins += 1;
      }
      s.stats.gamesPlayed += 1;
      saveStats(s.stats);
      break;
    }

    case 'NEW_GAME':
      s.players = s.players.map(p => ({ ...p, score: 0 }));
      s.questions = [];
      s.prefetchQueue = [];
      s.prefetchInflight = false;
      s.currentIndex = -1;
      s.roundAnswers = {};
      s.isBonusRound = false;
      s.phase = 'SETUP';
      break;

    case 'RESET_ALL': {
      const fresh = structuredClone(INITIAL_STATE);
      fresh.ui.isOnline = s.ui.isOnline;
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, fresh);
      clearAll();
      break;
    }

    case 'SET_ERROR':
      s.ui.lastError = { ...action.error, ts: Date.now() };
      break;

    case 'CLEAR_ERROR':
      s.ui.lastError = null;
      break;

    case 'SET_FETCHING':
      s.ui.isFetching = action.value;
      break;

    case 'SET_PREFETCH_INFLIGHT':
      s.prefetchInflight = action.value;
      break;

    case 'SET_ONLINE':
      s.ui.isOnline = action.value;
      break;

    default:
      console.warn('[state] action inconnue', action.type);
  }
}

// --- Préchargement (SPEC §11) ---

async function triggerInitialBatch() {
  if (getState().prefetchInflight) return;
  dispatch({ type: 'SET_FETCHING', value: true });
  dispatch({ type: 'SET_PREFETCH_INFLIGHT', value: true });
  try {
    const s = getState();
    const result = await fetchQuestionBatch({
      theme: s.settings.theme,
      batchSize: s.settings.batchSize || BATCH_SIZE,
      exclude: [],
    });
    dispatch({ type: 'BATCH_RECEIVED', questions: result.questions });
    if (getState().prefetchQueue.length > 0) {
      dispatch({ type: 'SHOW_NEXT_QUESTION' });
    }
  } catch (error) {
    dispatch({ type: 'SET_ERROR', error: toUiError(error) });
    dispatch({ type: 'NEW_GAME' });
  } finally {
    dispatch({ type: 'SET_FETCHING', value: false });
  }
}

function maybePrefetchNext() {
  const s = getState();
  const displayedNumber = s.questions.length;
  const queueSize = s.prefetchQueue.length;
  if (s.prefetchInflight || displayedNumber < 3 || queueSize > 2) return;
  if (!s.ui.isOnline) return;
  dispatch({ type: 'SET_PREFETCH_INFLIGHT', value: true });
  fetchQuestionBatch({
    theme: s.settings.theme,
    batchSize: s.settings.batchSize || BATCH_SIZE,
    exclude: s.history,
  }).then(({ questions }) => {
    dispatch({ type: 'BATCH_RECEIVED', questions });
  }).catch(error => {
    dispatch({ type: 'SET_ERROR', error: toUiError(error) });
    dispatch({ type: 'SET_PREFETCH_INFLIGHT', value: false });
  });
}

/**
 * Retry manuel de génération (bouton « Réessayer la génération »).
 */
export async function retryGeneration() {
  const s = getState();
  if (s.prefetchInflight) return;
  dispatch({ type: 'CLEAR_ERROR' });
  dispatch({ type: 'SET_PREFETCH_INFLIGHT', value: true });
  try {
    const result = await fetchQuestionBatch({
      theme: s.settings.theme,
      batchSize: s.settings.batchSize || BATCH_SIZE,
      exclude: s.history,
    });
    dispatch({ type: 'BATCH_RECEIVED', questions: result.questions });
  } catch (error) {
    dispatch({ type: 'SET_ERROR', error: toUiError(error) });
    dispatch({ type: 'SET_PREFETCH_INFLIGHT', value: false });
  }
}


