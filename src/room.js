// room.js — couche réseau du host (relais WebSocket, WS.md §18).
//
// Le host crée une room (POST /api/sessions) puis s'y connecte en WebSocket.
// Le serveur est un dumb relay : room.js traduit les messages reçus en actions
// du store et expose `send()` pour diffuser. La logique de jeu reste en state.js.

import { dispatch } from './state.js';

// En dev, le relais tourne sur un serveur séparé (:3000, lancé par
// `npm run dev-ws`). En prod, même origine que le front (Vercel).
const RELAY_ORIGIN = import.meta.env.DEV ? 'http://localhost:3000' : location.origin;

let ws = null;
let hostPlayerId = null;
let deliberateClose = false;

function wsUrl(sessionId) {
  const url = new URL('/api/ws', RELAY_ORIGIN.replace(/^http/, 'ws'));
  url.searchParams.set('sessionId', sessionId);
  return url;
}

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
    const socket = new WebSocket(wsUrl(sessionId));
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
      const name = String(msg.payload?.name ?? '').trim().slice(0, 18);
      const emoji = typeof msg.payload?.emoji === 'string' ? msg.payload.emoji : '•';
      // Le serveur ajoute `senderId` (identité attribuée par le relais).
      if (name) dispatch({ type: 'ROOM_JOIN', id: msg.senderId, name, emoji });
      break;
    }
    case 'lobby.leave':
    case 'player.left':
      dispatch({ type: 'ROOM_LEAVE', id: msg.senderId });
      break;
    // Les types `game.*` seront branchés à l'étape suivante (diffusion des
    // questions aux joueurs).
  }
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
