// server/relay.mjs — serveur de signalisation WebSocket auto-hébergé (VPS).
//
// Phase P2P (WS.md §18) : ce processus ne relaie PLUS les données de jeu. Il ne
// fait que la signalisation — présenter le host aux joueurs et router les
// messages d'établissement (offres/réponses/candidats ICE). Le transport des
// données se fait en direct (RTCDataChannel) entre le navigateur du MJ et ceux
// des joueurs.
//
// Un seul processus Node :
//   - POST /api/chat/completions → proxy LLM (BYOK + repli .env) ;
//   - GET  /api/health           → config LLM (model / temperature / batchSize) ;
//   - POST /api/sessions         → crée une room { sessionId, hostToken } ;
//   - GET  /api/relay/health     → santé (nb de rooms) ;
//   - WS   /api/ws?sessionId=…   → canal de signalisation (routage en étoile) ;
//   - GET  /* (hors /api)        → sert dist/ si présent (un seul serveur).
//
// Routage en étoile : tout message d'un joueur remonte au host ; tout message du
// host part vers un joueur ciblé (champ `targetId`) ou vers tous. Le serveur ne
// comprend pas le contenu (dumb signaling) et ne garde aucune donnée de jeu.
//
// Le host s'authentifie à la connexion WS par un jeton remis à la création de la
// session (`?role=host&token=…`) : lui seul peut diffuser. Les joueurs se
// connectent avec le seul `sessionId`.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { computeKey, getNonExcluded, addQuestions, extractQuestions, load, stats, listThemes } from './questionCache.mjs';

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 h : couvre une partie de 5 h + reconnexion
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

// sessionId -> { hostToken, hostPlayerId, clients: Map<playerId, ws>, expiresAt }
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

/** Réponse synthétique OpenAI-compatible servie depuis le cache. */
function serveCached(res, questions, model) {
  const content = JSON.stringify({ questions });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    id: 'chatcmpl-cache',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'cache',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }));
}

// --- Proxy LLM (BYOK + repli .env) — même contrat que le proxy Vite ---
function getServerConfig() {
  const baseUrl = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY || '';
  const model = process.env.LLM_MODEL || '';
  const temperature = process.env.LLM_TEMPERATURE || '0.9';
  const batchSize = process.env.LLM_BATCH_SIZE || '8';
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

  // Parse le body une fois : extraire _quiz (métadonnées de cache), le retirer,
  // puis injecter le modèle serveur si absent.
  let quiz = null;
  let forwardedBody = body;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed._quiz === 'object' && parsed._quiz !== null) {
      quiz = parsed._quiz;
    }
    delete parsed._quiz; // le provider n'a pas à le recevoir
    if (!parsed.model) parsed.model = serverModel;
    forwardedBody = JSON.stringify(parsed);
  } catch { /* forward tel quel */ }

  // --- Cache : servir depuis le pool si assez de questions non-exclues ---
  if (quiz && typeof quiz.theme === 'string' && quiz.theme) {
    const wanted = Number(quiz.batchSize) || 8;
    const key = computeKey(quiz);
    const cached = getNonExcluded(key, quiz.exclude, wanted);
    if (cached.length >= wanted) {
      serveCached(res, cached, serverModel);
      return;
    }
    if (quiz.cacheOnly) {
      // Mode hors ligne : jamais d'appel au LLM. On sert ce qui reste, sinon on
      // signale l'épuisement du pool.
      if (cached.length > 0) {
        serveCached(res, cached, serverModel);
        return;
      }
      return sendError(res, 409, 'CACHE_EXHAUSTED', 'Plus de questions en cache pour ce thème.');
    }
  }

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

  // --- Cache : remplir le pool avec la réponse fraîche (200 uniquement) ---
  if (quiz && typeof quiz.theme === 'string' && quiz.theme && upstreamResponse.status === 200) {
    try {
      const envelope = JSON.parse(responseBody);
      const content = envelope?.choices?.[0]?.message?.content;
      const questions = extractQuestions(content);
      if (questions.length) addQuestions(quiz, questions);
    } catch { /* réponse non-JSON : rien à cacher */ }
  }

  res.statusCode = upstreamResponse.status;
  res.setHeader('Content-Type', upstreamResponse.headers.get('content-type') || 'application/json');
  // Sur 429, transmettre Retry-After pour que le client attende le bon délai
  // (au lieu d'un backoff fixe). LiteLLM/OpenRouter peut l'omettre.
  const retryAfter = upstreamResponse.headers.get('retry-after');
  if (retryAfter) res.setHeader('Retry-After', retryAfter);
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

    // Proxy LLM : le front appelle ces routes.
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return handleHealth(res);
    }
    if (url.pathname === '/api/quiz/themes' && req.method === 'GET') {
      return sendJson(res, 200, { themes: listThemes() });
    }
    if (url.pathname === '/api/chat/completions' && req.method === 'POST') {
      return await handleChat(req, res);
    }

    // Relais : santé ops + création de session.
    if (url.pathname === '/api/relay/health') {
      return sendJson(res, 200, { ok: true, sessions: sessions.size, cache: stats() });
    }
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      const sessionId = randomId(32); // 64 hex — imprévisible (WS.md §10)
      const hostToken = randomId(24); // 48 hex — seul le host le connaît
      sessions.set(sessionId, {
        hostToken,
        hostPlayerId: null,
        clients: new Map(),
        expiresAt: Date.now() + SESSION_TTL_MS,
      });
      return sendJson(res, 201, { sessionId, hostToken });
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

function rejectUpgrade(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('sessionId');
  const role = url.searchParams.get('role');
  const token = url.searchParams.get('token');
  const session = sessionId ? sessions.get(sessionId) : null;

  // Format valide + session connue : sinon on refuse l'upgrade (404).
  if (!sessionId || !/^[a-f0-9]{16,64}$/i.test(sessionId) || !session) {
    rejectUpgrade(socket, 404, 'Not Found');
    return;
  }
  // Le host s'authentifie par le jeton remis à la création. Sans jeton valide,
  // on refuse : un joueur ne doit jamais pouvoir se faire passer pour le host.
  if (role === 'host' && (!token || token !== session.hostToken)) {
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, sessionId, role === 'host'));
});

wss.on('connection', (ws, sessionId, isHost) => {
  const session = sessions.get(sessionId);
  const playerId = `player-${randomId(6)}`;
  session.expiresAt = Date.now() + SESSION_TTL_MS; // activité → on prolonge

  if (isHost) {
    // Un nouveau host chasse l'ancien (reconnexion après coupure réseau) :
    // pas deux sources de vérité sur la même room.
    if (session.hostPlayerId && session.clients.has(session.hostPlayerId)) {
      try { session.clients.get(session.hostPlayerId).close(); } catch { /* ignore */ }
    }
    session.hostPlayerId = playerId;
  }
  session.clients.set(playerId, ws);

  // Identité attribuée par le serveur, jamais choisie par le client (WS.md §9).
  ws.send(JSON.stringify({
    type: 'session.connected',
    payload: { sessionId, playerId, role: isHost ? 'host' : 'player' },
  }));

  // Présence : seul le host est informé de l'arrivée d'un joueur.
  if (!isHost && session.hostPlayerId) {
    routeToHost(session, {
      type: 'player.joined',
      senderId: playerId,
      payload: { playerId, playersCount: playerCount(session) },
    });
  }

  // Signalisation : routage en étoile, `senderId` ajouté côté serveur. Un
  // `ping` du client ne se route pas : on répond `pong` pour mesurer la latence
  // (aller-retour) ; ce ping entretient aussi la connexion (NAT/proxys).
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong', payload: msg.payload })); } catch { /* ignore */ }
      return;
    }
    const envelope = { ...msg, senderId: playerId };
    if (isHost) routeFromHost(session, envelope);
    else routeToHost(session, envelope);
  });

  ws.on('close', () => {
    session.clients.delete(playerId);
    if (isHost) {
      if (session.hostPlayerId === playerId) session.hostPlayerId = null;
      return;
    }
    if (session.hostPlayerId) {
      routeToHost(session, {
        type: 'player.left',
        senderId: playerId,
        payload: { playerId, playersCount: playerCount(session) },
      });
    }
  });
});

/** Nombre de joueurs connectés (le host n'est pas un joueur). */
function playerCount(session) {
  let n = 0;
  for (const id of session.clients.keys()) {
    if (id !== session.hostPlayerId) n += 1;
  }
  return n;
}

function sendTo(session, playerId, message) {
  const client = playerId ? session.clients.get(playerId) : null;
  if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}

/** Player → host : tout message d'un joueur remonte au seul host. */
function routeToHost(session, message) {
  sendTo(session, session.hostPlayerId, message);
}

/**
 * Host → joueurs : vers un joueur ciblé (champ `targetId`), sinon vers tous.
 * Pas d'écho au host.
 */
function routeFromHost(session, message) {
  if (typeof message.targetId === 'string' && message.targetId) {
    sendTo(session, message.targetId, message);
    return;
  }
  const data = JSON.stringify(message);
  for (const [id, client] of session.clients) {
    if (id === session.hostPlayerId) continue;
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

load();
server.listen(PORT, () => {
  console.log(`[relay] signalisation WS + /api sur http://localhost:${PORT}${existsSync(join(DIST, 'index.html')) ? ' (sert aussi dist/)' : ''}`);
});

