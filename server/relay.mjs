// server/relay.mjs — relais WebSocket auto-hébergé (VPS), remplace le relais
// serverless Vercel + Redis (WS.md §18.6 révisé).
//
// Un seul processus Node :
//   - POST /api/sessions   → crée une session (id imprévisible) ;
//   - GET  /api/health     → santé ;
//   - WS   /api/ws?sessionId=… → relais « dumb » en mémoire (une room = les
//     sockets connectés à cet id) ;
//   - GET  /* (hors /api)  → sert dist/ si présent (un seul serveur pour tout).
//
// Plus de Redis (une seule instance suffit), plus de limite de durée : les
// connexions tiennent en mémoire, donc plus de coupure à 5 min. Le heartbeat
// sert d'anti-inactivité et de repère « dernier ping » côté client.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 h : couvre une partie de 5 h + reconnexion
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

// sessionId -> { clients: Map<playerId, ws>, expiresAt: number }
const sessions = new Map();

const randomId = (bytes) => randomBytes(bytes).toString('hex');

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

// --- Statique (dist/) : un seul serveur pour tout ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, pathname) {
  try {
    const rel = normalize(pathname).replace(/^[/\\]+/, '');
    let filePath = join(DIST, rel);
    if (!filePath.startsWith(DIST)) { res.statusCode = 403; res.end(); return; }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(DIST, 'index.html'); // SPA : tout chemin inconnu → index
    }
    const body = readFileSync(filePath);
    res.setHeader('Content-Type', MIME[extname(filePath)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
  }
}

const server = http.createServer((req, res) => {
  // CORS : en dev, le front (Vite) et le relais sont sur des origines différentes.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, sessions: sessions.size });
  }

  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    const sessionId = randomId(32); // 64 hex — imprévisible (WS.md §10)
    sessions.set(sessionId, { clients: new Map(), expiresAt: Date.now() + SESSION_TTL_MS });
    return sendJson(res, 201, { sessionId });
  }

  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    return serveStatic(res, url.pathname);
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('sessionId');
  // Format valide + session connue : sinon on refuse l'upgrade (404).
  if (!sessionId || !/^[a-f0-9]{16,64}$/i.test(sessionId) || !sessions.has(sessionId)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, sessionId));
});

wss.on('connection', (ws, sessionId) => {
  const session = sessions.get(sessionId);
  const playerId = `player-${randomId(6)}`;
  session.expiresAt = Date.now() + SESSION_TTL_MS; // activité → on prolonge
  session.clients.set(playerId, ws);

  // Identité attribuée par le serveur, jamais choisie par le client (WS.md §9).
  ws.send(JSON.stringify({ type: 'session.connected', payload: { sessionId, playerId } }));
  broadcast(session, playerId, {
    type: 'player.joined',
    payload: { playerId, playersCount: session.clients.size },
  });

  // Heartbeat : entretient la connexion (NAT/proxys) et sert de repère de
  // fraîcheur au client (« dernier ping »). Pas de maxDuration ici : la
  // connexion ne meurt pas d'elle-même.
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'ping', payload: { ts: Date.now() } })); } catch { /* ignore */ }
    }
  }, 15000);

  // Message client → relayé à la room, avec `senderId` ajouté côté serveur.
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    broadcast(session, playerId, { ...msg, senderId: playerId });
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    session.clients.delete(playerId);
    if (session.clients.size === 0) {
      // Room vide : on garde la session jusqu'au TTL pour la reconnexion du
      // host (le nettoyage périodique s'en chargera).
      return;
    }
    broadcast(session, playerId, {
      type: 'player.left',
      payload: { playerId, playersCount: session.clients.size },
    });
  });
});

/** Diffuse à toute la room, sans écho à l'expéditeur (WS.md §4.4). */
function broadcast(session, senderId, message) {
  const data = JSON.stringify(message);
  for (const [id, client] of session.clients) {
    if (id === senderId) continue;
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

// Nettoyage des sessions vides expirées (pas de fuite mémoire).
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.clients.size === 0 && session.expiresAt < now) sessions.delete(id);
  }
}, 60_000).unref();

server.listen(PORT, () => {
  console.log(`[relay] relais WS + /api sur http://localhost:${PORT}${existsSync(join(DIST, 'index.html')) ? ' (sert aussi dist/)' : ''}`);
});

