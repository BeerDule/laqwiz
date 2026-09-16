// api/sessions.js — création d'une room (WS.md §6.1).
//
// POST /api/sessions crée une room dans Redis Cloud et renvoie l'URL de
// partage. Aucune logique de jeu : le serveur ne fait qu'enregistrer la room.

import { randomBytes } from 'node:crypto';
import { getRedis, roomKey, ROOM_TTL_SECONDS } from './_redis.js';

// Aligné sur MAX_PLAYERS (constants.js). Le serveur ne fait que le stocker :
// l'application réelle du plafond reste une affaire de host (§18.3).
const MAX_PLAYERS = 6;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'POST uniquement.');
  }

  let redis;
  try {
    redis = getRedis();
  } catch (err) {
    return sendError(res, 500, 'REDIS_UNAVAILABLE', err.message);
  }

  // WS.md §10 : identifiant imprévisible, généré côté serveur uniquement.
  const sessionId = randomBytes(32).toString('hex'); // 64 hex chars
  const room = {
    id: sessionId,
    createdAt: Date.now(),
    status: 'waiting',
    maxPlayers: MAX_PLAYERS,
  };

  try {
    await redis.set(roomKey(sessionId), JSON.stringify(room), 'EX', ROOM_TTL_SECONDS);
  } catch (err) {
    console.error('[sessions] erreur Redis', err);
    return sendError(res, 500, 'SESSION_CREATION_FAILED', "Impossible de créer la session.");
  }

  const host = req.headers.host || 'example.com';
  const shareUrl = `https://${host}/#join=${sessionId}`;
  sendJson(res, 201, { sessionId, shareUrl });
}
