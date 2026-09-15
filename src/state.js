// state.js — source de vérité de l'application (SPEC §9, §10, §11).
import { normalizeQuestionText } from './validation.js';
import { fetchQuestionBatch, toUiError } from './api.js';
import { saveStats, clearAll, saveActiveSessionId } from './storage.js';
import { putSession, putPartie } from './db.js';
import { DEFAULTS, BONUS_CHANCE, BATCH_SIZE, SOURCE_BUDGET_CHARS } from './constants.js';
import { fetchArticle, sectionWindow } from './wikipedia.js';

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
    difficulty: DEFAULTS.difficulty,
    audience: DEFAULTS.audience,
    timerEnabled: DEFAULTS.timerEnabled,
    timePerQuestion: DEFAULTS.timePerQuestion,
    penaltyNoAnswer: DEFAULTS.penaltyNoAnswer,
    penaltyWrongAnswer: DEFAULTS.penaltyWrongAnswer,
    punisherSeverity: DEFAULTS.punisherSeverity,
    manchesTarget: DEFAULTS.manchesTarget,
    sourceMode: DEFAULTS.sourceMode,
    sourceTitle: DEFAULTS.sourceTitle,
    sourceLang: DEFAULTS.sourceLang,
    sourceUrl: DEFAULTS.sourceUrl,
    model: DEFAULTS.model,
    baseUrl: DEFAULTS.baseUrl,
    apiKey: DEFAULTS.apiKey,
    temperature: DEFAULTS.temperature,
    batchSize: DEFAULTS.batchSize,
  },

  // === Session : roster + sac de parties, sans condition de fin ===
  session: null, // { id, name, createdAt, status: 'active' | 'closed' }

  // === Partie en cours : best-of de manches ===
  partie: null,  // { id, startedAt, manchesTarget, mancheIndex, manchesWon, manches[] }

  // === Source Wikipédia (mode « article ») ===
  // Volontairement HORS de `settings` : celui-ci est réécrit dans localStorage
  // à chaque dispatch, et l'article pèse plusieurs kilo-octets.
  source: null, // { lang, title, url, sections[], cursor, wrapped, exhausted }

  // === Questions ===
  questions: [],
  currentIndex: -1,

  // === Saisie MJ sur la question courante ===
  roundAnswers: {},
  roundPenalties: {}, // { playerId: points réellement retirés ce tour }
  isBonusRound: false,

  // === Phase courante ===
  phase: 'HOME', // 'HOME' | 'SETUP' | 'LOADING' | 'QUESTION' | 'REVEAL' | 'VICTORY'

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

// --- Session et partie ---

function newId() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultSessionName(ts) {
  try {
    return `Session du ${new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;
  } catch { return 'Session'; }
}

function newSession() {
  const createdAt = Date.now();
  const session = { id: newId(), name: defaultSessionName(createdAt), createdAt, status: 'active' };
  setActiveSessionId(session.id);
  return session;
}

function newPartie(s) {
  return {
    id: newId(),
    sessionId: s.session.id,
    startedAt: Date.now(),
    endedAt: null,
    manchesTarget: s.settings.manchesTarget,
    mancheIndex: 0,
    manchesWon: {},
    manches: [],
    winnerId: null,
  };
}

function setActiveSessionId(id) {
  saveActiveSessionId(id);
}

/** Écrit la session dans l'archive. Le roster et l'anti-doublon y sont copiés
 *  pour qu'une reprise après rechargement retrouve l'état exact. */
function persistSession(s) {
  if (!s.session) return;
  putSession({
    ...s.session,
    players: s.players.map(({ id, name, emoji, color }) => ({ id, name, emoji, color })),
    history: s.history,
    updatedAt: Date.now(),
  });
}

function persistPartie(s) {
  if (!s.partie) return;
  putPartie({ ...s.partie, settings: { ...s.settings } });
}

/**
 * Retire des points à un joueur, plancher à 0. Enregistre la perte réellement
 * appliquée dans `roundPenalties` (l'écran de révélation affiche ce montant) et
 * répercute la même valeur sur les stats, pour qu'elles suivent le score net.
 */
function applyPenalty(s, p, cost) {
  const before = p.score;
  p.score = Math.max(0, p.score - cost);
  const lost = before - p.score;
  s.roundPenalties[p.id] = lost;
  if (lost > 0) {
    s.stats.perPlayer[p.id] = s.stats.perPlayer[p.id] || initPerPlayer(p);
    s.stats.perPlayer[p.id].totalScore -= lost;
  }
}

/**
 * Fin de MANCHE : le score cible est atteint (SPEC §10.3).
 * Attention, ce n'est plus la fin de la partie — celle-ci se joue au best-of.
 */
export function hasMancheWinner(s) {
  const target = s.settings.targetScore;
  const ranked = [...s.players].sort((a, b) => b.score - a.score);
  const leader = ranked[0];
  const second = ranked[1];
  if (!leader || leader.score < target) return false;
  if (!s.settings.twoPointLead) return true;
  return !second || leader.score - second.score >= 2;
}

/**
 * Gagnant de la manche courante (SPEC §10.4).
 */
export function computeMancheWinner(s) {
  const ranked = [...s.players].sort((a, b) => {
    const scoreDelta = b.score - a.score;
    if (scoreDelta !== 0) return scoreDelta;
    return s.players.indexOf(a) - s.players.indexOf(b);
  });
  return hasMancheWinner(s) ? ranked[0] : null;
}

/**
 * Nombre de manches à remporter pour gagner la partie. Le total étant impair,
 * cette majorité est toujours atteignable et jamais ex æquo.
 */
export function manchesNeeded(s) {
  return Math.floor((s.partie?.manchesTarget || s.settings.manchesTarget) / 2) + 1;
}

/**
 * Gagnant de la PARTIE : premier joueur à atteindre la majorité des manches.
 * Le best-of s'arrête dès ce moment, les manches restantes ne sont pas jouées.
 */
export function computePartieWinner(s) {
  if (!s.partie) return null;
  const needed = manchesNeeded(s);
  const id = Object.keys(s.partie.manchesWon)
    .find(pid => s.partie.manchesWon[pid] >= needed);
  return id ? s.players.find(p => p.id === id) || null : null;
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
      // Session implicite : elle naît au premier lancement et survit aux
      // parties suivantes. L'anti-doublon est porté par elle, donc on ne le
      // vide qu'avec une session neuve.
      if (!s.session) {
        s.session = newSession();
        s.history = [];
      }
      s.partie = newPartie(s);
      // Rechargé à chaque partie : un re-téléchargement coûte quelques centaines
      // de millisecondes et évite toute confusion si l'article a été changé.
      s.source = null;
      s.players = s.players.map(p => ({ ...p, score: 0 }));
      s.questions = [];
      s.prefetchQueue = [];
      s.prefetchInflight = false;
      s.currentIndex = -1;
      s.roundAnswers = {};
      s.roundPenalties = {};
      s.isBonusRound = false;
      s.phase = 'LOADING';
      persistSession(s);
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
      s.roundPenalties = {};
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
        } else if (!ans && s.settings.penaltyNoAnswer) {
          applyPenalty(s, p, 1);
        } else if (ans && s.settings.penaltyWrongAnswer) {
          // « Ultra punitive » : le ×2 des questions bonus s'applique aussi à la perte.
          applyPenalty(s, p, s.settings.punisherSeverity === 'ultra' ? bonusMult : 1);
        }
      }
      s.stats.questionsAnswered += s.players.length;
      s.stats.correctAnswers += correctCount;
      break;
    }

    // Le score cible clôt la MANCHE, pas la partie : on enregistre le résultat
    // puis on regarde si la majorité du best-of est atteinte.
    case 'END_MANCHE': {
      const winner = computeMancheWinner(s);
      s.partie.manches.push({
        index: s.partie.mancheIndex,
        winnerId: winner ? winner.id : null,
        scores: Object.fromEntries(s.players.map(p => [p.id, p.score])),
      });
      if (winner) {
        s.partie.manchesWon[winner.id] = (s.partie.manchesWon[winner.id] || 0) + 1;
      }
      const partieWinner = computePartieWinner(s);
      if (partieWinner) {
        s.phase = 'VICTORY';
        s.partie.winnerId = partieWinner.id;
        s.partie.endedAt = Date.now();
        s.stats.perPlayer[partieWinner.id] =
          s.stats.perPlayer[partieWinner.id] || initPerPlayer(partieWinner);
        s.stats.perPlayer[partieWinner.id].wins += 1;
        s.stats.gamesPlayed += 1;
        saveStats(s.stats);
      } else {
        s.phase = 'MANCHE_END';
      }
      persistPartie(s);
      persistSession(s);
      break;
    }

    case 'START_MANCHE':
      s.players = s.players.map(p => ({ ...p, score: 0 })); // RAZ systématique
      s.partie.mancheIndex += 1;
      s.questions = [];
      s.currentIndex = -1;
      s.roundAnswers = {};
      s.roundPenalties = {};
      s.isBonusRound = false;
      s.phase = 'LOADING';
      break;

    // Nouvelle partie dans la MÊME session : le roster et l'anti-doublon restent.
    case 'NEW_GAME':
      s.players = s.players.map(p => ({ ...p, score: 0 }));
      s.partie = null;
      s.questions = [];
      s.prefetchQueue = [];
      s.prefetchInflight = false;
      s.currentIndex = -1;
      s.roundAnswers = {};
      s.roundPenalties = {};
      s.isBonusRound = false;
      s.phase = 'SETUP';
      break;

    case 'SET_SOURCE':
      s.source = action.source;
      break;

    case 'GOTO_HOME':
      s.phase = 'HOME';
      break;

    case 'GOTO_SESSIONS':
      s.phase = 'SESSIONS';
      break;

    // Création explicite, sans passer par le lancement d'une partie.
    // La session précédente est archivée telle quelle avant d'être remplacée.
    case 'NEW_SESSION':
      if (s.session) {
        s.session = { ...s.session, status: 'closed' };
        persistSession(s);
      }
      s.session = newSession();
      s.history = [];
      s.partie = null;
      s.players = s.players.map(p => ({ ...p, score: 0 }));
      s.phase = 'SETUP';
      persistSession(s);
      break;

    case 'CLOSE_SESSION':
      if (s.session) {
        s.session = { ...s.session, status: 'closed' };
        persistSession(s);
      }
      s.session = null;
      s.partie = null;
      s.history = [];
      setActiveSessionId(null);
      s.phase = 'HOME';
      break;

    case 'RESUME_SESSION':
      s.session = { ...action.session, status: 'active' };
      s.history = Array.isArray(action.session.history) ? action.session.history : [];
      if (Array.isArray(action.session.players) && action.session.players.length) {
        s.players = action.session.players.map(p => ({ ...p, score: 0 }));
      }
      s.partie = null;
      s.phase = 'SETUP';
      setActiveSessionId(s.session.id); // sinon la reprise est perdue au rechargement
      persistSession(s);
      break;

    case 'RENAME_SESSION':
      if (s.session && s.session.id === action.id) {
        s.session = { ...s.session, name: action.name };
        persistSession(s);
      }
      break;

    case 'RESET_ALL': {
      const fresh = structuredClone(INITIAL_STATE);
      fresh.ui.isOnline = s.ui.isOnline;
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, fresh);
      clearAll();
      setActiveSessionId(null);
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

// --- Source Wikipédia ---

/**
 * Découpe la fenêtre de sections à envoyer pour le prochain lot et avance le
 * curseur. Renvoie null hors mode article, ou une fois la source épuisée.
 */
function takeSourceWindow() {
  const src = getState().source;
  if (!src || src.exhausted) return null;
  const { text, nextCursor, wrapped } = sectionWindow(
    src.sections, src.cursor, SOURCE_BUDGET_CHARS
  );
  src.cursor = nextCursor;
  if (wrapped) src.wrapped = true;
  return { title: src.title, text };
}

/**
 * L'article a fait le tour et ne rend plus rien d'inédit : on repasse en culture
 * générale sur le même sujet plutôt que d'interrompre la partie.
 */
function exhaustSource(reason) {
  const src = getState().source;
  if (!src || src.exhausted) return;
  src.exhausted = true;
  document.dispatchEvent(new CustomEvent('qc:toast', {
    detail: {
      message: `« ${src.title} » est épuisé (${reason}) : les questions passent en culture générale sur ce sujet.`,
      kind: 'info',
    },
  }));
}

/** Charge l'article avant le premier lot, en mode article seulement. */
async function ensureSourceLoaded() {
  const s = getState();
  if (s.settings.sourceMode !== 'wikipedia' || s.source) return;
  const article = await fetchArticle(s.settings.sourceTitle, s.settings.sourceLang);
  dispatch({ type: 'SET_SOURCE', source: { ...article, cursor: 0, wrapped: false, exhausted: false } });
}

// --- Préchargement (SPEC §11) ---

async function triggerInitialBatch() {
  if (getState().prefetchInflight) return;
  dispatch({ type: 'SET_FETCHING', value: true });
  dispatch({ type: 'SET_PREFETCH_INFLIGHT', value: true });
  try {
    await ensureSourceLoaded(); // en mode article : télécharge avant le 1er lot
    const s = getState();
    const result = await fetchQuestionBatch({
      theme: s.settings.theme,
      batchSize: s.settings.batchSize || BATCH_SIZE,
      exclude: [],
      source: takeSourceWindow(),
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
  const sourceWindow = takeSourceWindow();
  fetchQuestionBatch({
    theme: s.settings.theme,
    batchSize: s.settings.batchSize || BATCH_SIZE,
    exclude: s.history,
    source: sourceWindow,
  }).then(({ questions }) => {
    // L'article a déjà fait le tour ET ne rend plus rien d'inédit : on bascule.
    if (sourceWindow && questions.length === 0 && getState().source?.wrapped) {
      exhaustSource('plus de question inédite');
    }
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


