// room.js — couche réseau du host (signalisation WS + transport WebRTC, WS.md §18).
//
// Le host crée une room (POST /api/sessions → sessionId + hostToken) puis se
// connecte en WebSocket pour la SIGNALISATION. À l'arrivée de chaque joueur, il
// établit un RTCDataChannel direct (offre / réponse + candidats ICE relayés par
// le serveur). Les données de jeu transitent par le DataChannel ; le WS ne porte
// que la signalisation et les contrôles (rejet, fermeture).
//
// La logique de jeu reste dans state.js : room.js traduit les messages reçus en
// actions du store et expose des diffusions ciblées (projection, WS.md §18.4).

import { dispatch, getState, subscribe } from './state.js';
import { RELAY_ORIGIN, relayWsUrl } from './relay.js';
import { ICE_SERVERS } from './ice.js';
import { createDataPeer } from './rtc.js';
import { loadActiveSessionId } from './storage.js';
import { getSession, listResumes } from './db.js';
import { NAME_MAX_LENGTH, PLAYER_EMOJIS, MAX_LOBBY_PLAYERS } from './constants.js';

let ws = null;
let hostPlayerId = null;
let hostToken = null;
let deliberateClose = false;
let currentSessionId = null;
let rttMs = null; // dernière latence mesurée (aller-retour, ms)
let pingTimer = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let connState = 'offline'; // connecting | connected | reconnecting | offline

// --- Persistance de la room (reprise du host après rechargement) ---
// sessionStorage : survit à un F5 (rechargement), pas à une fermeture d'onglet.
// On y garde de quoi se reconnecter en host et rétablir les canaux directs.
const ROOM_STORAGE_KEY = 'quizz-canape:room-host';

function saveRoom(room) {
  try { sessionStorage.setItem(ROOM_STORAGE_KEY, JSON.stringify(room)); } catch { /* quota/privé */ }
}
function loadRoom() {
  try { return JSON.parse(sessionStorage.getItem(ROOM_STORAGE_KEY)); } catch { return null; }
}
function clearRoom() {
  try { sessionStorage.removeItem(ROOM_STORAGE_KEY); } catch { /* ignore */ }
}

/** True si cet onglet hébergeait une room avant un rechargement. */
export function hasPersistedRoom() {
  return !!loadRoom();
}

// Correspondance identité stable (clientId, généré côté client et persisté en
// localStorage) ↔ connexion éphémère (senderId, attribué par le relais). Sert à
// survivre au rechargement : un joueur qui revient réutilise son clientId, le
// host ré-associe la nouvelle connexion sans créer de doublon.
const clientToSender = new Map();
const senderToClient = new Map();

// clientId → canal de données direct (RTCDataChannel). La source de vérité du
// roster reste le store ; cette map ne sert qu'à router les diffusions.
const peers = new Map();

// Diffusion des questions/résultats aux joueurs (projection, WS.md §18.4 :
// jamais `answer`/`funnyOption`/`explanation` avant le reveal).
let lastQuestionSig = -1;
let lastRevealSig = -1;
let lastPhase = null;

subscribe((state) => {
  if (!state.room) return;
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
 * Crée la room puis ouvre la connexion de signalisation du host.
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
  hostToken = created.hostToken;
  await connect(created.sessionId);
  lastQuestionSig = -1;
  lastRevealSig = -1;
  lastPhase = null;
  // Lien construit côté client. On passe l'identifiant par HASH (et non un
  // chemin /game/<id>) : avec `base: './'`, une route imbriquée casserait la
  // résolution des assets (→ /game/assets/*.css qui n'existent pas).
  const shareUrl = `${location.origin}${location.pathname}#join=${created.sessionId}`;
  saveRoom({ sessionId: created.sessionId, hostToken: created.hostToken, shareUrl });
  dispatch({
    type: 'ROOM_OPENED',
    sessionId: created.sessionId,
    shareUrl,
    hostPlayerId,
  });
  return { sessionId: created.sessionId, shareUrl };
}

function connect(sessionId) {
  currentSessionId = sessionId;
  connState = 'connecting';
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relayWsUrl(sessionId, { role: 'host', token: hostToken }));
    ws = socket;

    socket.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'session.connected') {
        // Reconnexion après coupure réseau (pas un F5) : les canaux directs ont
        // pu tomber avec le WS — on fait re-postuler les joueurs (§18.7).
        const wasReconnect = reconnectAttempts > 0;
        hostPlayerId = msg.payload.playerId;
        connState = 'connected';
        reconnectAttempts = 0;
        rttMs = null;
        startPing();
        if (wasReconnect) broadcastRoomRejoin();
        resolve();
      } else if (msg.type === 'pong') {
        const ts = msg.payload?.ts;
        if (typeof ts === 'number') rttMs = Date.now() - ts;
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
      stopPing();
      rttMs = null;
      if (ws === socket) { ws = null; hostPlayerId = null; }
      const deliberate = deliberateClose;
      deliberateClose = false;
      // Room fermée volontairement (ou déjà fermée) : on ne reconnecte pas.
      if (deliberate || !getState().room) { connState = 'offline'; return; }
      connState = 'reconnecting';
      scheduleReconnect();
    });
  });
}

/**
 * Reconnexion automatique avec recul exponentiel (1 s → 10 s max). Une coupure
 * réseau (blip WiFi, redéploiement du relais) ferme la connexion : le host doit
 * rouvrir sans perdre l'état (celui-ci vit dans le store, pas dans le socket).
 */
function scheduleReconnect() {
  if (reconnectTimer || !currentSessionId) return;
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 10000);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!getState().room) { reconnectAttempts = 0; return; }
    connect(currentSessionId).catch(() => {
      // Échec : le `close` relancera scheduleReconnect.
    });
  }, delay);
}

/** Messages reçus sur le canal de signalisation (WS). */
function handle(msg) {
  switch (msg.type) {
    case 'lobby.join': {
      const senderId = msg.senderId;
      const clientId = typeof msg.payload?.clientId === 'string' ? msg.payload.clientId : '';
      const name = String(msg.payload?.name ?? '').trim().slice(0, NAME_MAX_LENGTH);
      const emoji = typeof msg.payload?.emoji === 'string' ? msg.payload.emoji : '';

      if (!clientId) {
        wsSend('lobby.join.rejected', senderId, { reason: 'invalid' });
        break;
      }

      const players = getState().players;

      // Rechargement : le même appareil se reconnecte avec son clientId. On
      // ré-associe la nouvelle connexion sans créer de doublon, on rouvre le
      // canal direct, puis on renvoie l'état courant à l'ouverture.
      if (players.some(p => p.id === clientId)) {
        remapSender(clientId, senderId);
        openPeer(clientId, senderId, (id) => {
          if (getState().phase === 'LOBBY') broadcastRoster();
          else sendGameState(id);
        });
        break;
      }

      // La partie est déjà lancée : plus personne ne rejoint.
      if (getState().phase !== 'LOBBY') {
        wsSend('lobby.join.rejected', senderId, { reason: 'started' });
        break;
      }

      // Checks côté host (le client ne fait pas foi) : nom insensible à la
      // casse, avatar dans la liste autorisée. En ligne l'avatar peut être en
      // doublon (42 joueurs pour 30 avatars) : seul le prénom est unique.
      if (!name || !PLAYER_EMOJIS.includes(emoji)) {
        wsSend('lobby.join.rejected', senderId, { reason: 'invalid' });
      } else if (players.length >= MAX_LOBBY_PLAYERS) {
        wsSend('lobby.join.rejected', senderId, { reason: 'full' });
      } else if (players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        wsSend('lobby.join.rejected', senderId, { reason: 'name-taken' });
      } else {
        remapSender(clientId, senderId);
        dispatch({ type: 'ROOM_JOIN', id: clientId, name, emoji });
        // Le roster sera diffusé à l'ouverture du canal direct (le nouveau
        // joueur n'a pas encore de canal, inutile de diffuser maintenant).
        openPeer(clientId, senderId, () => broadcastRoster());
      }
      break;
    }
    case 'lobby.leave':
    case 'player.left': {
      const clientId = senderToClient.get(msg.senderId);
      if (!clientId) break;
      senderToClient.delete(msg.senderId);
      clientToSender.delete(clientId);
      peers.get(clientId)?.close();
      const inLobby = getState().phase === 'LOBBY';
      // Départ explicite (« Se déconnecter ») ou en lobby : on retire le siège.
      // En pleine partie, une déconnexion réseau (rechargement) garde le siège
      // pour permettre le rejoin (§18.7) — le joueur ré-associe sa connexion.
      if (msg.type === 'lobby.leave' || inLobby) {
        dispatch({ type: 'ROOM_LEAVE', id: clientId });
      }
      if (inLobby) broadcastRoster();
      break;
    }
    case 'rtc.answer': {
      const clientId = senderToClient.get(msg.senderId);
      peers.get(clientId)?.handleSignal({ type: 'answer', sdp: msg.payload?.sdp });
      break;
    }
    case 'rtc.ice': {
      const clientId = senderToClient.get(msg.senderId);
      peers.get(clientId)?.handleSignal({ type: 'ice', candidate: msg.payload?.candidate });
      break;
    }
  }
}

/**
 * Ouvre (ou rouvre) le canal de données direct vers un joueur. Le host est
 * toujours l'initiateur (il crée le DataChannel et l'offre). `senderId` est le
 * playerId attribué par le serveur — c'est LUI que le routage étoile utilise
 * (pas le clientId, inconnu du serveur). `onReady` est appelé à l'ouverture.
 */
function openPeer(clientId, senderId, onReady) {
  const previous = peers.get(clientId);
  if (previous) { peers.delete(clientId); previous.close(); }

  const peer = createDataPeer({
    initiator: true,
    iceServers: ICE_SERVERS,
    onSignal: (sig) => {
      if (sig.type === 'offer') wsSend('rtc.offer', senderId, { sdp: sig.sdp });
      else if (sig.type === 'ice') wsSend('rtc.ice', senderId, { candidate: sig.candidate });
    },
    onOpen: () => onReady(clientId),
    onMessage: (msg) => handleData(clientId, msg),
    onClose: () => {
      // Canal tombé : on ne reprend que si l'entrée est encore la nôtre (sinon
      // c'est un remplacement par rejoin, qui ne doit pas relancer la reprise).
      if (peers.get(clientId) !== peer) return;
      peers.delete(clientId);
      schedulePeerRestart(clientId);
    },
  });
  peers.set(clientId, peer);
}

/**
 * Reprise d'un canal de données tombé (coupure réseau du pair sans que son WS de
 * signalisation soit mort). Le host re-propose une offre après un court délai ;
 * le joueur reçoit l'offre et re-crée son pair (ensurePeer). On renvoie la
 * projection courante à l'ouverture pour resynchroniser l'écran du joueur.
 */
function schedulePeerRestart(clientId) {
  const s = getState();
  // Pas de reprise si on ferme la room, si le joueur a quitté (siège libéré),
  // ou si sa connexion de signalisation n'est plus mappée.
  if (!s.room) return;
  if (!s.players.some(p => p.id === clientId)) return;
  if (!clientToSender.has(clientId)) return;
  setTimeout(() => {
    if (!getState().room) return;
    if (peers.has(clientId)) return; // déjà rouvert (rejoin concurrent)
    const senderId = clientToSender.get(clientId);
    if (!senderId) return;
    openPeer(clientId, senderId, (id) => {
      if (getState().phase === 'LOBBY') broadcastRoster();
      else sendGameState(id);
    });
  }, 500);
}

/** Messages de données reçus d'un joueur (sur son canal direct). */
function handleData(clientId, msg) {
  switch (msg.type) {
    case 'game.answer': {
      const optionKey = msg.payload?.optionKey;
      const s = getState();
      // Chrono écoulé : réponse refusée, même si le reveal n'est pas encore
      // parti (l'échéance fait foi, pas l'action du MJ).
      if (s.deadlineAt && Date.now() > s.deadlineAt) return;
      const player = s.players.find(p => p.id === clientId);
      if (!player || player.eliminated || s.phase !== 'QUESTION') return;
      if (!['A', 'B', 'C', 'D'].includes(optionKey)) return;
      dispatch({ type: 'PLAYER_ANSWER', playerId: clientId, optionKey });
      break;
    }
    case 'game.answer.cancel': {
      // Annulation tardive (après révélation) : ne pas muter `roundAnswers`,
      // sinon le rejoin du reveal afficherait « pas de réponse » à tort.
      if (getState().phase !== 'QUESTION') return;
      dispatch({ type: 'CLEAR_PLAYER_ANSWER', playerId: clientId });
      break;
    }
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
  const manche = state.partie;
  const prepared = state.questions.length + state.prefetchQueue.length;
  return {
    question: q.question,
    options: q.options.map(o => ({ key: o.key, text: o.text })),
    difficulty: q.difficulty,
    isBonus: state.isBonusRound,
    theme: q.theme || state.settings.theme,
    manche: manche ? manche.mancheIndex + 1 : 1,
    manchesTarget: manche ? manche.manchesTarget : state.settings.manchesTarget,
    index: state.currentIndex + 1,
    total: prepared,
    deadline: state.deadlineAt || null,
  };
}

/** Projection de la révélation (réponse + textes + résultats de chacun). */
function revealPayload(state) {
  const q = state.questions[state.currentIndex];
  if (!q) return null;
  const answerOption = q.options.find(o => o.key === q.answer);
  const funnyOption = q.options.find(o => o.key === q.funnyOption);
  return {
    question: q.question,
    options: q.options.map(o => ({ key: o.key, text: o.text })),
    difficulty: q.difficulty,
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
    if (question) {
      // La réponse déjà envoyée survit au rechargement : on la renvoie pour
      // que le joueur retrouve sa sélection.
      question.myAnswer = s.roundAnswers[targetId] || null;
      sendTo(targetId, 'game.state', { question });
    }
  } else if (s.phase === 'REVEAL') {
    const reveal = revealPayload(s);
    if (reveal) sendTo(targetId, 'game.state', { reveal });
  } else if (s.phase === 'MANCHE_END') {
    sendTo(targetId, 'game.state', { mancheEnd: mancheEndPayload(s) });
  } else if (s.phase === 'VICTORY') {
    sendTo(targetId, 'game.state', { victory: victoryPayload(s) });
  } else {
    // LOADING : la prochaine question arrivera d'elle-même.
    sendTo(targetId, 'game.state', { waiting: true });
  }
}

/** Diffuse le roster courant aux joueurs (projection, WS.md §18.4). */
export function broadcastRoster() {
  send('lobby.roster', {
    players: getState().players.map(p => ({ id: p.id, name: p.name, emoji: p.emoji })),
  });
}

/** Envoie un message de signalisation/contrôle sur le WS. `targetId` est un
 *  `playerId` serveur (routage étoile) — jamais un `clientId`. */
function wsSend(type, targetId, payload) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const msg = { type, payload };
  if (targetId) msg.targetId = targetId;
  ws.send(JSON.stringify(msg));
}

/** Diffuse un message de jeu à tous les joueurs (sur leurs canaux directs). */
export function send(type, payload) {
  const envelope = { type, payload };
  for (const peer of peers.values()) peer.send(envelope);
}

/** Envoie un message de jeu à un seul joueur (sur son canal direct). */
function sendTo(clientId, type, payload) {
  peers.get(clientId)?.send({ type, payload });
}

export function closeRoom() {
  // Prévenir les joueurs (contrôle) puis fermer les canaux directs.
  wsSend('room.closed', null, {});
  for (const peer of peers.values()) peer.close();
  peers.clear();
  deliberateClose = true;
  currentSessionId = null;
  connState = 'offline';
  stopPing();
  rttMs = null;
  reconnectAttempts = 0;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    try { ws.close(); } catch { /* déjà fermé */ }
    ws = null;
  }
  hostPlayerId = null;
  hostToken = null;
  clearRoom();
}

/** Ping de latence (RTT) : le host envoie `ping`, le relais répond `pong`. */
function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping', payload: { ts: Date.now() } }));
    }
  }, 5000);
}
function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

/** État de connexion pour l'indicateur visuel (host). */
export function getConnInfo() {
  return { state: connState, rttMs };
}

/** Ferme la room si on est en ligne, et remet l'état à zéro (no-op sinon). */
export function leaveRoomIfOnline() {
  if (!getState().room) return;
  closeRoom();
  dispatch({ type: 'ROOM_CLOSED' });
}

/**
 * Reprise du host après un rechargement (F5). Reconnexion de la signalisation,
 * restauration de l'état de jeu depuis l'archive, puis on fait re-postuler les
 * joueurs pour rétablir leurs canaux directs.
 */
export async function rejoinHost() {
  const room = loadRoom();
  if (!room?.sessionId || !room?.hostToken) return;
  hostToken = room.hostToken;
  try {
    await connect(room.sessionId);
  } catch (err) {
    console.error('[room] reprise host impossible :', err.message);
    clearRoom();
    return;
  }

  const restored = await restoreGameState();
  const shareUrl = room.shareUrl || `${location.origin}${location.pathname}#join=${room.sessionId}`;
  dispatch({
    type: restored ? 'ROOM_REJOINED' : 'ROOM_OPENED',
    sessionId: room.sessionId,
    shareUrl,
    hostPlayerId,
  });
  // Les joueurs, toujours connectés en WS, re-postulent (room.rejoin →
  // lobby.join) et retrouvent un canal direct via le rejoin existant.
  broadcastRoomRejoin();
}

/** Restaure session + partie depuis l'archive. True si une partie était en cours. */
async function restoreGameState() {
  const activeSessionId = loadActiveSessionId();
  if (!activeSessionId) return false;
  const session = await getSession(activeSessionId);
  if (!session || session.status !== 'active') return false;
  dispatch({ type: 'RESUME_SESSION', session });
  const snapshots = await listResumes(session.id);
  if (snapshots.length) {
    dispatch({ type: 'RESUME_PARTIE', snapshot: snapshots[0] });
    return true;
  }
  return false;
}

/** Diffuse aux joueurs qu'ils doivent re-postuler (canaux directs tombés). */
function broadcastRoomRejoin() {
  wsSend('room.rejoin', null, {});
}
