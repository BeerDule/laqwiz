// room.js — couche réseau du host (relais WebSocket, WS.md §18).
//
// Le host crée une room (POST /api/sessions) puis s'y connecte en WebSocket.
// Le serveur est un dumb relay : room.js traduit les messages reçus en actions
// du store et expose `send()` pour diffuser. La logique de jeu reste en state.js.

import { dispatch, getState, subscribe } from './state.js';
import { RELAY_ORIGIN, relayWsUrl } from './relay.js';
import { NAME_MAX_LENGTH, PLAYER_EMOJIS } from './constants.js';

let ws = null;
let hostPlayerId = null;
let deliberateClose = false;

// Correspondance identité stable (clientId, généré côté client et persisté en
// localStorage) ↔ connexion éphémère (senderId, attribué par le relais). Sert à
// survivre au rechargement : un joueur qui revient réutilise son clientId, le
// host ré-associe la nouvelle connexion sans créer de doublon.
const clientToSender = new Map();
const senderToClient = new Map();

// Diffusion des questions/résultats aux joueurs (projection, WS.md §18.4 :
// jamais `answer`/`funnyOption`/`explanation` avant le reveal).
let lastQuestionSig = -1;
let lastRevealSig = -1;
let lastPhase = null;

subscribe((state) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (state.phase === 'QUESTION' && state.currentIndex !== lastQuestionSig) {
    lastQuestionSig = state.currentIndex;
    broadcastQuestion(state);
  } else if (state.phase === 'REVEAL' && state.currentIndex !== lastRevealSig) {
    lastRevealSig = state.currentIndex;
    broadcastReveal(state);
  } else if (state.phase === 'MANCHE_END' && lastPhase !== 'MANCHE_END') {
    broadcastMancheEnd(state);
  } else if (state.phase === 'VICTORY' && lastPhase !== 'VICTORY') {
    broadcastVictory(state);
  }
  lastPhase = state.phase;
});

/**
 * Crée la room puis ouvre la connexion WS du host.
 * Résout { sessionId, shareUrl } une fois `session.connected` reçu.
 */
export async function startHost() {
  const res = await fetch(`${RELAY_ORIGIN}/api/sessions`, { method: 'POST' });
  if (!res.ok) {
    let message = 'Impossible de créer le lobby.';
    try {
      const data = await res.json();
      if (data?.error?.message) message = data.error.message;
    } catch { /* corps illisible : message générique */ }
    throw new Error(message);
  }
  const created = await res.json();
  await connect(created.sessionId);
  lastQuestionSig = -1;
  lastRevealSig = -1;
  lastPhase = null;
  // Lien construit côté client. On passe l'identifiant par HASH (et non un
  // chemin /game/<id>) : avec `base: './'`, une route imbriquée casserait la
  // résolution des assets (→ /game/assets/*.css qui n'existent pas).
  const shareUrl = `${location.origin}${location.pathname}#join=${created.sessionId}`;
  dispatch({
    type: 'ROOM_OPENED',
    sessionId: created.sessionId,
    shareUrl,
    hostPlayerId,
  });
  return { sessionId: created.sessionId, shareUrl };
}

function connect(sessionId) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relayWsUrl(sessionId));
    ws = socket;

    socket.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'session.connected') {
        hostPlayerId = msg.payload.playerId;
        resolve();
      } else {
        handle(msg);
      }
    });

    socket.addEventListener('error', () => {
      ws = null;
      hostPlayerId = null;
      reject(new Error('Connexion au lobby impossible.'));
    });

    socket.addEventListener('close', () => {
      if (ws === socket) { ws = null; hostPlayerId = null; }
      if (!deliberateClose) {
        document.dispatchEvent(new CustomEvent('qc:toast', {
          detail: { message: 'Connexion au lobby perdue.', kind: 'error' },
        }));
      }
      deliberateClose = false;
    });
  });
}

function handle(msg) {
  switch (msg.type) {
    case 'lobby.join': {
      const senderId = msg.senderId;
      const clientId = typeof msg.payload?.clientId === 'string' ? msg.payload.clientId : '';
      const name = String(msg.payload?.name ?? '').trim().slice(0, NAME_MAX_LENGTH);
      const emoji = typeof msg.payload?.emoji === 'string' ? msg.payload.emoji : '';

      if (!clientId) {
        send('lobby.join.rejected', { targetId: senderId, reason: 'invalid' });
        break;
      }

      const players = getState().players;

      // Rechargement : le même appareil se reconnecte avec son clientId. On
      // ré-associe la nouvelle connexion sans créer de doublon, puis on renvoie
      // l'état courant (roster en lobby, projection ciblée en pleine partie).
      if (players.some(p => p.id === clientId)) {
        remapSender(clientId, senderId);
        if (getState().phase === 'LOBBY') {
          broadcastRoster();
        } else {
          sendGameState(clientId);
        }
        break;
      }

      // La partie est déjà lancée : plus personne ne rejoint.
      if (getState().phase !== 'LOBBY') {
        send('lobby.join.rejected', { targetId: clientId, reason: 'started' });
        break;
      }

      // Checks d'unicité côté host (le client ne fait pas foi) : nom
      // insensible à la casse, avatar unique, avatar dans la liste autorisée.
      if (!name || !PLAYER_EMOJIS.includes(emoji)) {
        send('lobby.join.rejected', { targetId: clientId, reason: 'invalid' });
      } else if (players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        send('lobby.join.rejected', { targetId: clientId, reason: 'name-taken' });
      } else if (players.some(p => p.emoji === emoji)) {
        send('lobby.join.rejected', { targetId: clientId, reason: 'emoji-taken' });
      } else {
        remapSender(clientId, senderId);
        dispatch({ type: 'ROOM_JOIN', id: clientId, name, emoji });
        broadcastRoster();
      }
      break;
    }
    case 'lobby.leave':
    case 'player.left': {
      const clientId = senderToClient.get(msg.senderId);
      if (!clientId) break;
      senderToClient.delete(msg.senderId);
      clientToSender.delete(clientId);
      const inLobby = getState().phase === 'LOBBY';
      // Départ explicite (« Se déconnecter ») ou en lobby : on retire le siège.
      // En pleine partie, une déconnexion réseau (rechargement) garde le siège
      // pour permettre le rejoin (§18.7) — le joueur re-associe sa connexion.
      if (msg.type === 'lobby.leave' || inLobby) {
        dispatch({ type: 'ROOM_LEAVE', id: clientId });
      }
      // On ne re-diffuse le roster qu'en lobby : en pleine partie, le broadcast
      // ferait retomber les autres joueurs sur l'écran d'attente.
      if (inLobby) broadcastRoster();
      break;
    }
    case 'game.answer': {
      const clientId = senderToClient.get(msg.senderId);
      const optionKey = msg.payload?.optionKey;
      const s = getState();
      // Le joueur ne répond qu'en phase QUESTION, s'il existe et n'est pas éliminé.
      const player = clientId && s.players.find(p => p.id === clientId);
      if (!player || player.eliminated || s.phase !== 'QUESTION') break;
      if (!['A', 'B', 'C', 'D'].includes(optionKey)) break;
      dispatch({ type: 'PLAYER_ANSWER', playerId: clientId, optionKey });
      break;
    }
    // game.answer arrivera à l'étape suivante (réponses des joueurs).
  }
}

/** Ré-associe un clientId à une (nouvelle) connexion du relais. */
function remapSender(clientId, senderId) {
  const old = clientToSender.get(clientId);
  if (old) senderToClient.delete(old);
  clientToSender.set(clientId, senderId);
  senderToClient.set(senderId, clientId);
}

/** Projection de la question courante (sans la réponse, WS.md §18.4). */
function questionPayload(state) {
  const q = state.questions[state.currentIndex];
  if (!q) return null;
  return {
    question: q.question,
    options: q.options.map(o => ({ key: o.key, text: o.text })),
    difficulty: q.difficulty,
    isBonus: state.isBonusRound,
    deadline: state.settings.timerEnabled
      ? Date.now() + (state.settings.timePerQuestion || 60) * 1000
      : null,
  };
}

/** Projection de la révélation (réponse + textes + résultats de chacun). */
function revealPayload(state) {
  const q = state.questions[state.currentIndex];
  if (!q) return null;
  const answerOption = q.options.find(o => o.key === q.answer);
  const funnyOption = q.options.find(o => o.key === q.funnyOption);
  return {
    answer: q.answer,
    answerText: answerOption?.text || q.answer,
    funnyOption: q.funnyOption,
    funnyText: funnyOption?.text || '',
    explanation: q.explanation,
    results: state.players.map(p => ({
      id: p.id,
      name: p.name,
      emoji: p.emoji,
      score: p.score,
      answered: state.roundAnswers[p.id] || null,
      penalty: state.roundPenalties[p.id] || 0,
      eliminated: !!p.eliminated,
    })),
  };
}

/** Projection de la fin de manche. */
function mancheEndPayload(state) {
  const manches = state.partie?.manches || [];
  const last = manches[manches.length - 1];
  const won = state.partie?.manchesWon || {};
  return {
    winnerId: last?.winnerId || null,
    manchesTarget: state.partie?.manchesTarget ?? 1,
    players: state.players.map(p => ({
      id: p.id,
      name: p.name,
      emoji: p.emoji,
      score: last?.scores?.[p.id] ?? p.score,
      manchesWon: won[p.id] || 0,
    })),
  };
}

/** Projection de la victoire. */
function victoryPayload(state) {
  const won = state.partie?.manchesWon || {};
  let winnerId = null;
  let best = -1;
  for (const p of state.players) {
    const w = won[p.id] || 0;
    if (w > best) { best = w; winnerId = p.id; }
  }
  return {
    winnerId,
    players: state.players.map(p => ({
      id: p.id,
      name: p.name,
      emoji: p.emoji,
      score: p.score,
      manchesWon: won[p.id] || 0,
    })),
  };
}

function broadcastQuestion(state) {
  const p = questionPayload(state);
  if (p) send('game.question', p);
}

function broadcastReveal(state) {
  const p = revealPayload(state);
  if (p) send('game.reveal', p);
}

function broadcastMancheEnd(state) {
  send('game.manche_end', mancheEndPayload(state));
}

function broadcastVictory(state) {
  send('game.victory', victoryPayload(state));
}

/** Rejoin en pleine partie : renvoie l'état courant, ciblé sur ce joueur. */
function sendGameState(targetId) {
  const s = getState();
  if (s.phase === 'QUESTION') {
    const question = questionPayload(s);
    if (question) send('game.state', { targetId, question });
  } else if (s.phase === 'REVEAL') {
    const reveal = revealPayload(s);
    if (reveal) send('game.state', { targetId, reveal });
  } else if (s.phase === 'MANCHE_END') {
    send('game.state', { targetId, mancheEnd: mancheEndPayload(s) });
  } else if (s.phase === 'VICTORY') {
    send('game.state', { targetId, victory: victoryPayload(s) });
  } else {
    // LOADING : la prochaine question arrivera d'elle-même.
    send('game.state', { targetId, waiting: true });
  }
}

/**
 * Diffuse le roster courant aux joueurs (projection, WS.md §18.4).
 * Le relais étant un dumb relay, ce message part vers tous les joueurs ;
 * chacun s'en sert pour afficher qui est connecté.
 */
function broadcastRoster() {
  send('lobby.roster', {
    players: getState().players.map(p => ({ id: p.id, name: p.name, emoji: p.emoji })),
  });
}

/** Diffuse un message vers la room (relayé à tous les autres clients). */
export function send(type, payload) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

export function closeRoom() {
  // Prévenir les joueurs avant de couper (le relais relaie ce message).
  if (ws?.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'room.closed', payload: {} })); } catch { /* ignore */ }
  }
  deliberateClose = true;
  if (ws) {
    try { ws.close(); } catch { /* déjà fermé */ }
    ws = null;
  }
  hostPlayerId = null;
}

/** Ferme la room si on est en ligne, et remet l'état à zéro (no-op sinon). */
export function leaveRoomIfOnline() {
  if (!getState().room) return;
  closeRoom();
  dispatch({ type: 'ROOM_CLOSED' });
}
