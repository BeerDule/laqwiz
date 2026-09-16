// state.js — source de vérité de l'application (SPEC §9, §10, §11).
import { normalizeQuestionText } from './validation.js';
import { fetchQuestionBatch, toUiError } from './api.js';
import { saveStats, clearAll, saveActiveSessionId } from './storage.js';
import { putSession, putPartie, putResume, deleteResume } from './db.js';
import { DEFAULTS, BONUS_CHANCE, BATCH_SIZE, SOURCE_BUDGET_CHARS, MODE_RULE_KEYS, PLAYER_COLORS } from './constants.js';
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
    suddenDeathEnabled: DEFAULTS.suddenDeathEnabled,
    suddenDeathStrikes: DEFAULTS.suddenDeathStrikes,
    // Mode de jeu appliqué. Les règles ci-dessus restent la vérité : `modeId` dit
    // seulement de quel preset elles sont parties, pour afficher « (modifié) »
    // quand elles en ont divergé.
    modeId: DEFAULTS.modeId,
    sourceMode: DEFAULTS.sourceMode,
    sourceTitle: DEFAULTS.sourceTitle,
    sourceLang: DEFAULTS.sourceLang,
    sourceUrl: DEFAULTS.sourceUrl,
  },

  // === Configuration LLM ===
  // Délibérément HORS de `settings` : celui-ci est recopié en entier dans chaque
  // partie archivée et chaque instantané de reprise. La clé API s'y retrouvait
  // dupliquée à chaque sauvegarde, dans des enregistrements conservés
  // indéfiniment. Elle est aussi globale à l'appareil, pas propre à une partie.
  llm: {
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

  // === Lobby en ligne (relais WebSocket, WS.md §18) ===
  room: null, // { sessionId, shareUrl, hostPlayerId, connected }

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
  phase: 'HOME', // 'HOME' | 'SETUP' | 'LOBBY' | 'LOADING' | 'QUESTION' | 'REVEAL' | 'MANCHE_END' | 'VICTORY'

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
    // Parties interrompues de la session courante, la plus récente d'abord.
    // Transient : la source de vérité reste le store IndexedDB.
    resumables: [],
    // Modes de jeu disponibles. Transient de la même façon : le store
    // IndexedDB fait foi, ceci n'en est que la copie affichable.
    modes: [],
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

/**
 * Instantané de la partie en cours, pour la reprendre après une interruption.
 *
 * Appelé aux moments qui comptent (question affichée, réponse saisie, manche
 * close) et NON à chaque dispatch : une transaction IndexedDB par clic serait
 * le même gaspillage que celui déjà évité pour le chronomètre.
 *
 * La file de préchargement est incluse : sans elle, une reprise hors ligne
 * n'aurait aucune question à afficher. L'article Wikipédia l'est aussi —
 * quelques milliers de caractères, contre un nouveau téléchargement sinon.
 */
function persistResume(s) {
  if (!s.session || !s.partie) return null;
  // Une partie gagnée n'est pas reprenable : sans ce garde, quitter l'écran de
  // victoire recréait un instantané pour une partie terminée, et le bandeau de
  // reprise apparaissait alors qu'il n'y avait plus rien à reprendre.
  if (s.partie.winnerId || s.phase === 'VICTORY') return null;
  const snapshot = {
    partieId: s.partie.id, // clé du store : une entrée par partie
    sessionId: s.session.id,
    savedAt: Date.now(),
    phase: s.phase,
    partie: s.partie,
    // strikes/eliminated inclus : sans eux, reprendre une partie interrompue
    // ressusciterait les joueurs éliminés de la manche en cours.
    players: s.players.map(({ id, name, emoji, color, score, strikes, eliminated }) =>
      ({ id, name, emoji, color, score, strikes: strikes || 0, eliminated: !!eliminated })),
    questions: s.questions,
    currentIndex: s.currentIndex,
    roundAnswers: s.roundAnswers,
    roundPenalties: s.roundPenalties,
    isBonusRound: s.isBonusRound,
    prefetchQueue: s.prefetchQueue,
    history: s.history,
    source: s.source,
    settings: { ...s.settings },
  };
  putResume(snapshot);
  return snapshot; // rendu pour que l'appelant puisse le proposer aussitôt
}

/** La partie porte son `sessionId` : on ne dépend donc pas de l'ordre dans
 *  lequel session et partie ont été restaurées. */
function dropResume(s) {
  const id = s.partie?.id;
  if (!id) return;
  deleteResume(id);
  // On ne retire QUE cette partie : les autres parties interrompues de la
  // session restent reprenables.
  s.ui.resumables = s.ui.resumables.filter(r => r.partieId !== id);
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
 * Remet les joueurs à zéro pour une nouvelle manche : score, fautes et
 * élimination.
 *
 * Six endroits ouvrent un nouveau contexte de score. En rater un laisserait
 * un joueur éliminé à vie, alors que la mort subite est bornée à la manche.
 */
function freshScores(players) {
  return players.map(p => ({ ...p, score: 0, strikes: 0, eliminated: false }));
}

/** Joueurs encore en lice dans la manche courante. */
export function activePlayers(s) {
  return s.players.filter(p => !p.eliminated);
}

/**
 * Mort subite : enregistre une faute et élimine au seuil.
 *
 * Une absence de réponse compte comme une faute, au même titre qu'une
 * mauvaise : rester muet ne doit pas être une stratégie de survie.
 */
function registerStrike(s, p) {
  if (!s.settings.suddenDeathEnabled || p.eliminated) return;
  p.strikes = (p.strikes || 0) + 1;
  if (p.strikes >= s.settings.suddenDeathStrikes) p.eliminated = true;
}

/**
 * Fin de MANCHE : le score cible est atteint (SPEC §10.3).
 * Attention, ce n'est plus la fin de la partie — celle-ci se joue au best-of.
 */
export function hasMancheWinner(s) {
  // Mort subite : le dernier debout remporte la manche sur-le-champ, quel
  // que soit son score. Sans cette sortie, une manche où tout le monde est
  // éliminé ne se terminerait jamais — plus personne ne peut marquer, donc
  // le score cible reste hors de portée indéfiniment.
  if (s.settings.suddenDeathEnabled && activePlayers(s).length <= 1) return true;

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
  if (s.settings.suddenDeathEnabled) {
    const debout = activePlayers(s);
    // Un seul survivant : il gagne, la cible ne compte plus.
    if (debout.length === 1) return debout[0];
    // Tout le monde est tombé, éventuellement sur la même question : le
    // meilleur score tranche, l'ordre du roster départage les ex æquo.
    if (debout.length === 0) {
      return [...s.players].sort((a, b) => (b.score - a.score)
        || (s.players.indexOf(a) - s.players.indexOf(b)))[0] || null;
    }
  }

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

/** Couleur suivante pour un joueur qui rejoint un lobby (rotation auto). */
function nextRoomColor(players) {
  const used = new Set(players.map(p => p.color));
  return PLAYER_COLORS.find(c => !used.has(c))
    || PLAYER_COLORS[players.length % PLAYER_COLORS.length];
}

function reducer(s, action) {
  switch (action.type) {
    case 'SET_PLAYERS':
      s.players = freshScores(action.players);
      break;

    case 'UPDATE_PLAYER': {
      const idx = s.players.findIndex(p => p.id === action.id);
      if (idx >= 0) s.players[idx] = { ...s.players[idx], ...action.patch };
      break;
    }

    case 'REMOVE_PLAYER':
      s.players = s.players.filter(p => p.id !== action.id);
      break;

    case 'ROOM_OPENED':
      s.room = {
        sessionId: action.sessionId,
        shareUrl: action.shareUrl,
        hostPlayerId: action.hostPlayerId,
        connected: true,
      };
      // En ligne, le roster vient des joins : on repart de zéro (MJ = animateur).
      s.players = [];
      s.phase = 'LOBBY';
      break;

    case 'ROOM_JOIN': {
      if (!s.players.some(p => p.id === action.id)) {
        s.players.push({
          id: action.id,
          name: action.name,
          emoji: action.emoji,
          color: nextRoomColor(s.players),
          score: 0,
        });
      }
      break;
    }

    case 'ROOM_LEAVE':
      s.players = s.players.filter(p => p.id !== action.id);
      break;

    case 'ROOM_CLOSED':
      s.room = null;
      s.players = [];
      break;

    case 'SET_LLM':
      s.llm = { ...s.llm, ...action.patch };
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
      // Une nouvelle partie remplace l'instantané précédent : c'est le seul
      // moment où l'on renonce vraiment à reprendre.
      dropResume(s);
      s.ui.resumables = [];
      s.partie = newPartie(s);
      // Rechargé à chaque partie : un re-téléchargement coûte quelques centaines
      // de millisecondes et évite toute confusion si l'article a été changé.
      s.source = null;
      s.players = freshScores(s.players);
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
      persistResume(s);
      maybePrefetchNext();
      break;
    }

    case 'PLAYER_ANSWER':
      s.roundAnswers[action.playerId] = action.optionKey;
      persistResume(s);
      break;

    case 'CLEAR_PLAYER_ANSWER':
      delete s.roundAnswers[action.playerId];
      persistResume(s);
      break;

    case 'REVEAL_ANSWER': {
      s.phase = 'REVEAL';
      const q = s.questions[s.currentIndex];
      const correctKey = q.answer;
      const bonusMult = s.isBonusRound ? 2 : 1;
      let correctCount = 0;
      let comptes = 0;
      for (const p of s.players) {
        // Éliminé en mort subite : son score n'est plus affecté du tout. Ni
        // gain, ni pénalité, ni comptage dans les statistiques. Il revient à
        // la manche suivante.
        if (p.eliminated) continue;
        comptes++;

        const ans = s.roundAnswers[p.id];
        if (ans === correctKey) {
          p.score += bonusMult;
          correctCount++;
          s.stats.perPlayer[p.id] = s.stats.perPlayer[p.id] || initPerPlayer(p);
          s.stats.perPlayer[p.id].totalScore += bonusMult;
        } else {
          if (!ans && s.settings.penaltyNoAnswer) {
            applyPenalty(s, p, 1);
          } else if (ans && s.settings.penaltyWrongAnswer) {
            // « Ultra punitive » : le ×2 des bonus s'applique aussi à la perte.
            applyPenalty(s, p, s.settings.punisherSeverity === 'ultra' ? bonusMult : 1);
          }
          // Mauvaise réponse OU absence de réponse : une faute dans les deux cas.
          registerStrike(s, p);
        }
      }
      s.stats.questionsAnswered += comptes;
      s.stats.correctAnswers += correctCount;
      persistResume(s);
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
      // Partie gagnée : plus rien à reprendre. Sinon on garde l'instantané.
      if (s.phase === 'VICTORY') dropResume(s); else persistResume(s);
      break;
    }

    case 'START_MANCHE':
      s.players = freshScores(s.players); // RAZ systématique
      s.partie.mancheIndex += 1;
      s.questions = [];
      s.currentIndex = -1;
      s.roundAnswers = {};
      s.roundPenalties = {};
      s.isBonusRound = false;
      s.phase = 'LOADING';
      persistResume(s);
      break;

    // Nouvelle partie dans la MÊME session : le roster et l'anti-doublon restent.
    case 'NEW_GAME':
      // Quitter, rejouer, revenir aux réglages : NEW_GAME sert à quatre
      // intentions. Aucune n'est un abandon — on garde donc l'instantané et on
      // le propose tout de suite, sans attendre un rechargement de page.
      const quitte = persistResume(s);
      if (quitte) {
        s.ui.resumables = [quitte, ...s.ui.resumables.filter(r => r.partieId !== quitte.partieId)];
      }
      s.players = freshScores(s.players);
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

    /**
     * Reprise d'une partie interrompue. On restaure l'état de jeu tel qu'il
     * était, y compris la file de préchargement : la partie peut donc repartir
     * même hors ligne, avec les questions déjà téléchargées.
     *
     * Les réglages sont restaurés depuis l'instantané et non depuis
     * localStorage : ce sont ceux qui étaient en vigueur au lancement, et ils
     * peuvent avoir été modifiés depuis dans l'écran de réglages.
     */
    // Abandon explicite d'UNE partie, visée par son identifiant : les autres
    // parties interrompues de la session ne bougent pas.
    case 'DISCARD_RESUME': {
      const id = action.partieId;
      if (!id) break;
      deleteResume(id);
      s.ui.resumables = s.ui.resumables.filter(r => r.partieId !== id);
      break;
    }

    case 'SET_MODES':
      s.ui.modes = Array.isArray(action.modes) ? action.modes : [];
      break;

    /**
     * Applique un mode aux réglages de partie.
     *
     * Ne recopie que les règles : le thème et la source Wikipédia survivent,
     * pour qu'on puisse durcir les règles sans reperdre l'article choisi.
     */
    case 'APPLY_MODE': {
      const mode = (s.ui.modes || []).find(m => m.id === action.modeId);
      if (!mode) break;
      for (const k of MODE_RULE_KEYS) s.settings[k] = mode.settings[k];
      s.settings.modeId = mode.id;
      break;
    }

    case 'SET_RESUMABLES':
      s.ui.resumables = Array.isArray(action.snapshots) ? action.snapshots : [];
      break;

    case 'RESUME_PARTIE': {
      const r = action.snapshot;
      if (!r || !r.partie) break;
      // Garde-fou : une partie appartient à sa session. Reprendre l'instantané
      // d'une autre session mélangerait deux rosters et deux historiques.
      if (s.session && r.sessionId && r.sessionId !== s.session.id) {
        console.warn('[state] instantané ignoré : il appartient à une autre session');
        break;
      }
      s.settings = { ...s.settings, ...r.settings };
      s.partie = r.partie;
      s.players = (r.players || []).map(p => ({ ...p, score: p.score || 0 }));
      s.questions = r.questions || [];
      s.currentIndex = typeof r.currentIndex === 'number' ? r.currentIndex : -1;
      s.roundAnswers = r.roundAnswers || {};
      s.roundPenalties = r.roundPenalties || {};
      s.isBonusRound = !!r.isBonusRound;
      s.prefetchQueue = r.prefetchQueue || [];
      s.prefetchInflight = false; // toute requête en vol est morte avec l'onglet
      s.history = Array.isArray(r.history) ? r.history : s.history;
      s.source = r.source || null;
      // Une partie sauvegardée en LOADING n'a rien à afficher : on la relance.
      s.phase = r.phase === 'LOADING' ? 'LOADING' : r.phase;
      // Reprise : cette partie n'est plus « en attente », les autres si.
      s.ui.resumables = s.ui.resumables.filter(x => x.partieId !== r.partieId);
      if (s.phase === 'LOADING') triggerInitialBatch();
      break;
    }

    case 'GOTO_HOME':
      s.phase = 'HOME';
      break;

    case 'GOTO_SETTINGS':
      s.phase = 'SETTINGS';
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
      // Session neuve : elle n'a aucune partie interrompue. Sans cette ligne,
      // le panneau continuait d'afficher celles de la session précédente.
      s.ui.resumables = [];
      s.players = freshScores(s.players);
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
      s.ui.resumables = [];
      setActiveSessionId(null);
      s.phase = 'HOME';
      break;

    case 'RESUME_SESSION':
      s.session = { ...action.session, status: 'active' };
      s.history = Array.isArray(action.session.history) ? action.session.history : [];
      if (Array.isArray(action.session.players) && action.session.players.length) {
        s.players = freshScores(action.session.players);
      }
      s.partie = null;
      // L'instantané appartient à UNE session : on le vide en changeant de
      // session, l'appelant chargera celui de la nouvelle.
      s.ui.resumables = [];
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
      // La config LLM survit : elle est globale à l'appareil, pas propre à la
      // soirée qu'on remet à zéro. Sans cette ligne, l'abonné de main.js
      // réécrirait une config vide par-dessus celle que clearAll() épargne.
      fresh.llm = { ...s.llm };
      // Les modes vivent en base et ne sont pas propres à la soirée ; les vider
      // ici afficherait un sélecteur vide jusqu'au prochain rechargement.
      fresh.ui.modes = s.ui.modes;
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
      batchSize: s.llm.batchSize || BATCH_SIZE,
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
    batchSize: s.llm.batchSize || BATCH_SIZE,
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
      batchSize: s.llm.batchSize || BATCH_SIZE,
      exclude: s.history,
    });
    dispatch({ type: 'BATCH_RECEIVED', questions: result.questions });
  } catch (error) {
    dispatch({ type: 'SET_ERROR', error: toUiError(error) });
    dispatch({ type: 'SET_PREFETCH_INFLIGHT', value: false });
  }
}


