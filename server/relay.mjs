// server/relay.mjs — relais WebSocket auto-hébergé (VPS) : sessions + relais en
// mémoire + statique + proxy LLM (WS.md §18.6).
//
// Un seul processus Node :
//   - POST /api/chat/completions → proxy LLM (BYOK + repli .env) ;
//   - GET  /api/health           → config LLM (model / temperature / batchSize) ;
//   - POST /api/sessions         → crée une session (id imprévisible) ;
//   - GET  /api/relay/health     → santé du relais (nb de sessions) ;
//   - WS   /api/ws?sessionId=…   → relais « dumb » en mémoire (une room = les
//     sockets connectés à cet id) ;
//   - GET  /* (hors /api)        → sert dist/ si présent (un seul serveur).
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

function sendError(res, status, code, message) {
  return sendJson(res, status, { error: { code, message } });
}

// --- Proxy LLM (BYOK + repli .env) — même contrat que le proxy Vite ---
function getServerConfig() {
  const baseUrl = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY || '';
  const model = process.env.LLM_MODEL || '';
  const temperature = process.env.LLM_TEMPERATURE || '0.9';
  const batchSize = process.env.LLM_BATCH_SIZE || '5';
  return { baseUrl, apiKey, model, temperature, batchSize };
}

// Plages réservées qu'une URL fournie par le client ne doit jamais atteindre :
// sinon le relais devient un proxy ouvert vers le réseau interne de l'hôte.
const BLOCKED_HOSTNAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

function isPrivateAddress(host) {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (h === '::1' || h === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;  // unique-local fc00::/7
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true;  // link-local fe80::/10
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return false;
  const [a, b] = v4.slice(1).map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;          // link-local / métadonnées cloud
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function rejectUnsafeUpstream(raw) {
  let url;
  try { url = new URL(raw); } catch { return 'URL de provider invalide.'; }
  if (url.protocol !== 'https:') return 'Le provider doit être joignable en https.';
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return 'Adresse de provider non autorisée.';
  }
  if (isPrivateAddress(host)) return 'Adresse de provider non autorisée.';
  return null;
}

function handleHealth(res) {
  const { baseUrl, model, temperature, batchSize } = getServerConfig();
  return sendJson(res, 200, {
    ok: true,
    provider: baseUrl,
    model,
    temperature: parseFloat(temperature),
    batchSize: parseInt(batchSize, 10),
    // JAMAIS la clé
  });
}

async function handleChat(req, res) {
  const { baseUrl: serverBaseUrl, apiKey: serverApiKey, model: serverModel } = getServerConfig();

  let body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks).toString('utf8');
  } catch {
    return sendError(res, 400, 'EMPTY_BODY', 'Corps de requête vide.');
  }
  if (!body) return sendError(res, 400, 'EMPTY_BODY', 'Corps de requête vide.');

  const clientBaseUrl = String(req.headers['x-llm-base-url'] || '').trim().replace(/\/+$/, '');
  const clientApiKey = String(req.headers['x-llm-api-key'] || '').trim();

  // Seule l'URL venant du client est filtrée : celle du .env est choisie par
  // l'exploitant, qui a le droit de viser un service interne.
  if (clientBaseUrl) {
    const refus = rejectUnsafeUpstream(clientBaseUrl);
    if (refus) return sendError(res, 400, 'UNSAFE_LLM_BASE_URL', refus);
  }

  const effectiveBaseUrl = clientBaseUrl || serverBaseUrl;
  const effectiveApiKey = clientApiKey || serverApiKey;

  if (!effectiveBaseUrl || !effectiveApiKey) {
    return sendError(res, 500, 'MISSING_LLM_CONFIG',
      'Configuration LLM manquante. Renseignez vos identifiants ou configurez le serveur.');
  }

  // Injecter le modèle serveur si absent du body
  let forwardedBody = body;
  try {
    const parsed = JSON.parse(body);
    if (!parsed.model) parsed.model = serverModel;
    forwardedBody = JSON.stringify(parsed);
  } catch { /* forward tel quel */ }

  const targetUrl = `${effectiveBaseUrl}/chat/completions`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 30_000);

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${effectiveApiKey}`,
      },
      body: forwardedBody,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(tid);
    if (err.name === 'AbortError') {
      return sendError(res, 504, 'UPSTREAM_TIMEOUT', 'Le provider LLM n\'a pas répondu en 30 s.');
    }
    return sendError(res, 502, 'UPSTREAM_UNREACHABLE', `Impossible de joindre le provider (${targetUrl}).`);
  }
  clearTimeout(tid);

  const responseBody = await upstreamResponse.text();

  // Garde-fou : pas de fuite de clé
  if (effectiveApiKey && responseBody.includes(effectiveApiKey)) {
    console.error('[quizz-canape] ALERTE: la réponse upstream contient la clé API !');
  }

  res.statusCode = upstreamResponse.status;
  res.setHeader('Content-Type', upstreamResponse.headers.get('content-type') || 'application/json');
  res.end(responseBody);
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

const server = http.createServer(async (req, res) => {
  try {
    // CORS : en dev, le front (Vite) et le relais sont sur des origines différentes.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-LLM-Base-URL, X-LLM-Api-Key');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

    const url = new URL(req.url, 'http://localhost');

    // Proxy LLM : le front appelle ces deux routes.
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return handleHealth(res);
    }
    if (url.pathname === '/api/chat/completions' && req.method === 'POST') {
      return await handleChat(req, res);
    }

    // Relais : santé ops + création de session.
    if (url.pathname === '/api/relay/health') {
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
  } catch (err) {
    console.error('[relay] erreur non gérée :', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Internal server error');
  }
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

