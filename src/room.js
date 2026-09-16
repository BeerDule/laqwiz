// room.js — couche réseau du host (relais WebSocket, WS.md §18).
//
// Le host crée une room (POST /api/sessions) puis s'y connecte en WebSocket.
// Le serveur est un dumb relay : room.js traduit les messages reçus en actions
// du store et expose `send()` pour diffuser. La logique de jeu reste en state.js.

import { dispatch, getState } from './state.js';
import { RELAY_ORIGIN, relayWsUrl } from './relay.js';
import { NAME_MAX_LENGTH, PLAYER_EMOJIS } from './constants.js';

let ws = null;
let hostPlayerId = null;
let deliberateClose = false;

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
  // Lien construit côté client : en dev, le relais (:3000) n'a pas l'origine
  // du front (:5173). En prod, même origine, donc équivalent.
  const shareUrl = new URL(`/game/${created.sessionId}`, location.origin).href;
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
      // Le serveur ajoute `senderId` (identité attribuée par le relais).
      const targetId = msg.senderId;
      const name = String(msg.payload?.name ?? '').trim().slice(0, NAME_MAX_LENGTH);
      const emoji = typeof msg.payload?.emoji === 'string' ? msg.payload.emoji : '';

      // La partie est déjà lancée : plus personne ne rejoint.
      if (getState().phase !== 'LOBBY') {
        send('lobby.join.rejected', { targetId, reason: 'started' });
        break;
      }

      // Checks d'unicité côté host (le client ne fait pas foi) : nom
      // insensible à la casse, avatar unique, avatar dans la liste autorisée.
      const players = getState().players;
      if (!name || !PLAYER_EMOJIS.includes(emoji)) {
        send('lobby.join.rejected', { targetId, reason: 'invalid' });
      } else if (players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        send('lobby.join.rejected', { targetId, reason: 'name-taken' });
      } else if (players.some(p => p.emoji === emoji)) {
        send('lobby.join.rejected', { targetId, reason: 'emoji-taken' });
      } else {
        dispatch({ type: 'ROOM_JOIN', id: targetId, name, emoji });
        broadcastRoster();
      }
      break;
    }
    case 'lobby.leave':
    case 'player.left':
      dispatch({ type: 'ROOM_LEAVE', id: msg.senderId });
      broadcastRoster();
      break;
    // game.answer arrivera à l'étape suivante (réponses des joueurs).
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
  deliberateClose = true;
  if (ws) {
    try { ws.close(); } catch { /* déjà fermé */ }
    ws = null;
  }
  hostPlayerId = null;
}
