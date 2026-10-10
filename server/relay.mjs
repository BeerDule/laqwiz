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
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { computeKey, getNonExcluded, addQuestions, extractQuestions, load, stats, listThemes } from './questionCache.mjs';
import {
  FREE_GAMES_PER_MONTH, PACK_PRICE_CENTS, PACK_CREDITS,
  load as loadAccounts, getOrCreateUser, createSession, getUserBySession, deleteSession,
  accountSummary, consumeGame, getGameTokenOwner, endGame, creditPurchase,
  listUsers, setPurchasedCredits,
} from './accounts.mjs';

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 h : couvre une partie de 5 h + reconnexion
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

// sessionId -> { hostToken, hostPlayerId, clients: Map<playerId, ws>, expiresAt }
const sessions = new Map();

const randomId = (bytes) => randomBytes(bytes).toString('hex');

// --- Comptes / paiement (mode payant) ---
// `ACCOUNT_GATED` + identifiants Google : tant que la config n'est pas complète,
// le mode reste inactif (BYOK / cache seuls), comme avant. La clé serveur n'est
// alors protégée par aucun compte — exactement le comportement actuel.
const ACCOUNT_GATED = /^(1|true|yes|on)$/i.test(String(process.env.ACCOUNT_GATED ?? '').trim());
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
// Email du compte administrateur : seul lui accède à /api/admin/*.
const ADMIN_USER_EMAIL = (process.env.ADMIN_USER_EMAIL || '').trim().toLowerCase();
const SESSION_COOKIE = 'qc_session';
const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 jours (secondes)

function isAccountGated() {
  // Le gate protège la clé LLM du serveur : sans clé à protéger, il n'y a pas de
  // mode payant. Un serveur à moitié configuré (Google OK, clé LLM absente) reste
  // en BYOK/cache au lieu d'afficher un compte qui échouerait à la première partie.
  const { baseUrl, apiKey } = getServerConfig();
  return ACCOUNT_GATED && Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && baseUrl && apiKey);
}

/** Le compte connecté est-il l'administrateur (ADMIN_USER_EMAIL) ? */
function isAdminUser(req) {
  if (!ADMIN_USER_EMAIL) return false;
  const user = getUserBySession(sessionToken(req));
  return !!user && String(user.email || '').trim().toLowerCase() === ADMIN_USER_EMAIL;
}

/** Origine publique (pour les URLs Stripe et la redirection OAuth). */
function appOrigin(req) {
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${req.headers.host}`;
}

// --- Cookies de session (HttpOnly, jamais lus par JS) ---
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}
function sessionToken(req) { return parseCookies(req)[SESSION_COOKIE] || null; }
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE}; SameSite=Lax`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// --- État OAuth (anti-CSRF), en mémoire ---
const oauthStates = new Map(); // state -> expiresAt (ms)
function makeOauthState() {
  const state = randomBytes(24).toString('hex');
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);
  return state;
}
function consumeOauthState(state) {
  const exp = oauthStates.get(state);
  oauthStates.delete(state);
  return typeof exp === 'number' && exp > Date.now();
}
function googleAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function verifyStripeSignature(rawBody, sigHeader) {
  if (!STRIPE_WEBHOOK_SECRET || !sigHeader) return false;
  const parts = String(sigHeader).split(',').reduce((acc, p) => {
    const i = p.indexOf('=');
    if (i > 0) acc[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    return acc;
  }, {});
  if (!parts.t || !parts.v1) return false;
  const expected = createHmac('sha256', STRIPE_WEBHOOK_SECRET)
    .update(`${parts.t}.${rawBody.toString('utf8')}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

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

async function handleGoogleCallback(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || !consumeOauthState(state)) {
    return sendError(res, 400, 'INVALID_STATE', 'Échange OAuth invalide ou expiré.');
  }
  let tokens;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI, grant_type: 'authorization_code',
      }),
    });
    tokens = await r.json();
  } catch {
    return sendError(res, 502, 'OAUTH_FAILED', 'Échange OAuth impossible.');
  }
  const accessToken = tokens?.access_token;
  if (!accessToken) {
    console.error('[accounts] échange OAuth refusé :', tokens?.error_description || tokens?.error);
    return sendError(res, 401, 'OAUTH_FAILED', 'Connexion Google refusée.');
  }
  let profile;
  try {
    const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    profile = await r.json();
  } catch {
    return sendError(res, 502, 'OAUTH_FAILED', 'Profil Google injoignable.');
  }
  const sub = profile?.sub;
  if (!sub) return sendError(res, 401, 'OAUTH_FAILED', 'Profil Google incomplet.');
  const userId = getOrCreateUser({
    sub, email: profile.email || '', name: profile.name || profile.email || '',
  });
  setSessionCookie(res, createSession(userId));
  res.statusCode = 302;
  res.setHeader('Location', `${appOrigin(req)}/`);
  res.end();
}

async function handleCheckout(req, res) {
  const user = getUserBySession(sessionToken(req));
  if (!user) return sendError(res, 401, 'AUTH_REQUIRED', 'Connectez-vous d\'abord.');
  if (!STRIPE_SECRET_KEY) {
    return sendError(res, 503, 'STRIPE_NOT_CONFIGURED', 'Paiement non configuré côté serveur.');
  }
  const origin = appOrigin(req);
  const params = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(PACK_PRICE_CENTS),
    'line_items[0][price_data][product_data][name]': `Canap' QuiZZ — ${PACK_CREDITS} parties`,
    'success_url': `${origin}/api/account/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    'cancel_url': `${origin}/`,
    'client_reference_id': String(user.id),
    'metadata[user_id]': String(user.id),
    'metadata[credits]': String(PACK_CREDITS),
  });
  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
      body: params,
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('[accounts] checkout Stripe refusé :', data?.error?.message || r.status);
      return sendError(res, 502, 'STRIPE_FAILED', 'Création du paiement impossible.');
    }
    return sendJson(res, 200, { url: data.url });
  } catch {
    return sendError(res, 502, 'STRIPE_FAILED', 'Stripe injoignable.');
  }
}

async function handleWebhook(req, res) {
  const rawBody = await readRawBody(req);
  if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'])) {
    return sendError(res, 400, 'INVALID_SIGNATURE', 'Signature Stripe invalide.');
  }
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch {
    return sendError(res, 400, 'BAD_PAYLOAD', 'Payload Stripe illisible.');
  }
  // On n'acquitte que l'événement qui crédite ; le reste est ignoré (200 = OK).
  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object;
    const userId = Number(session?.client_reference_id ?? session?.metadata?.user_id ?? 0);
    const credits = Number(session?.metadata?.credits ?? PACK_CREDITS);
    if (Number.isInteger(userId) && userId > 0 && Number.isInteger(credits) && credits > 0) {
      creditPurchase(userId, session.id, credits);
    }
  }
  return sendJson(res, 200, { received: true });
}

function serveCheckoutSuccess(res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Merci !</title>
    <body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f1115;color:#e6e8ee;text-align:center">
      <div>
        <h1>🎉 Merci !</h1>
        <p>Vos ${PACK_CREDITS} parties ont été ajoutées à votre compte.</p>
        <p><a href="/" style="color:#7dd3fc">Retour au jeu</a></p>
      </div>
    </body>`);
}

function handleHealth(res) {
  const { baseUrl, model, temperature, batchSize } = getServerConfig();
  return sendJson(res, 200, {
    ok: true,
    provider: baseUrl,
    model,
    temperature: parseFloat(temperature),
    batchSize: parseInt(batchSize, 10),
    // Comptes (mode payant) : le client n'affiche le flux « Compte » que si le
    // serveur l'annonce. Jamais de secret ici.
    accountGated: isAccountGated(),
    googleClientId: GOOGLE_CLIENT_ID,
    freeGamesPerMonth: FREE_GAMES_PER_MONTH,
    packPriceCents: PACK_PRICE_CENTS,
    packCredits: PACK_CREDITS,
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
  // Le mode « cache only » ne requiert AUCUNE configuration LLM : cette logique
  // doit donc venir AVANT la vérification de config, sinon un déploiement BYOK
  // (sans .env LLM) renverrait 500 au lieu de servir le pool.
  if (quiz && typeof quiz.theme === 'string' && quiz.theme) {
    const wanted = Number(quiz.batchSize) || 8;
    const key = computeKey(quiz);
    const cached = getNonExcluded(key, quiz.difficulty, quiz.exclude, wanted);
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

  // --- Mode payant : sans clé client, la clé serveur n'est servie qu'à un compte
  // authentifié ayant une partie en cours (game token consommé au lancement). ---
  if (isAccountGated() && !clientApiKey) {
    const user = getUserBySession(sessionToken(req));
    if (!user) {
      return sendError(res, 401, 'AUTH_REQUIRED',
        'Connectez-vous avec Google pour utiliser la clé du serveur.');
    }
    const gameToken = String(req.headers['x-game-token'] || '');
    if (!gameToken || getGameTokenOwner(gameToken) !== user.id) {
      return sendError(res, 402, 'PAYMENT_REQUIRED',
        'Aucune partie en cours sur ce compte. Relancez une partie.');
    }
  }

  const effectiveBaseUrl = clientBaseUrl || serverBaseUrl;
  const effectiveApiKey = clientApiKey || serverApiKey;

  if (!effectiveBaseUrl || !effectiveApiKey) {
    return sendError(res, 500, 'MISSING_LLM_CONFIG',
      'Configuration LLM manquante. Renseignez vos identifiants ou configurez le serveur.');
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-LLM-Base-URL, X-LLM-Api-Key, X-Game-Token');
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

    // --- Comptes / paiement (mode payant) ---
    if (url.pathname === '/api/auth/google' && req.method === 'GET') {
      if (!isAccountGated()) return sendError(res, 404, 'NOT_FOUND', 'Comptes non activés.');
      const state = makeOauthState();
      res.statusCode = 302;
      res.setHeader('Location', googleAuthUrl(state));
      return res.end();
    }
    if (url.pathname === '/api/auth/google/callback' && req.method === 'GET') {
      return await handleGoogleCallback(req, res);
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      deleteSession(sessionToken(req));
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/account/me' && req.method === 'GET') {
      const user = getUserBySession(sessionToken(req));
      const summary = user ? accountSummary(user.id) : null;
      return sendJson(res, 200, {
        signedIn: !!summary,
        gated: isAccountGated(),
        freeGamesPerMonth: FREE_GAMES_PER_MONTH,
        packPriceCents: PACK_PRICE_CENTS,
        packCredits: PACK_CREDITS,
        isAdmin: !!user && ADMIN_USER_EMAIL && String(user.email || '').trim().toLowerCase() === ADMIN_USER_EMAIL,
        ...(summary || {}),
      });
    }
    if (url.pathname === '/api/account/games' && req.method === 'POST') {
      const user = getUserBySession(sessionToken(req));
      if (!user) return sendError(res, 401, 'AUTH_REQUIRED', 'Connectez-vous d\'abord.');
      const result = consumeGame(user.id);
      if (!result) {
        return sendError(res, 402, 'NO_CREDITS', 'Plus de parties disponibles. Achetez un pack pour continuer.');
      }
      return sendJson(res, 200, { ...result, ...accountSummary(user.id) });
    }
    if (url.pathname === '/api/account/games/end' && req.method === 'POST') {
      const body = await readJsonBody(req);
      endGame(body?.gameToken || req.headers['x-game-token'] || '');
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/account/checkout' && req.method === 'POST') {
      return await handleCheckout(req, res);
    }
    if (url.pathname === '/api/account/checkout/success' && req.method === 'GET') {
      return serveCheckoutSuccess(res);
    }
    if (url.pathname === '/api/account/webhook' && req.method === 'POST') {
      return await handleWebhook(req, res);
    }

    // --- Administration (réservée à ADMIN_USER_EMAIL) ---
    if (url.pathname === '/api/admin/users' && req.method === 'GET') {
      if (!isAdminUser(req)) return sendError(res, 403, 'FORBIDDEN', 'Accès réservé à l\'administrateur.');
      return sendJson(res, 200, { users: listUsers() });
    }
    const adminCredits = /^\/api\/admin\/users\/(\d+)\/credits$/.exec(url.pathname);
    if (adminCredits && req.method === 'POST') {
      if (!isAdminUser(req)) return sendError(res, 403, 'FORBIDDEN', 'Accès réservé à l\'administrateur.');
      const userId = Number(adminCredits[1]);
      const body = await readJsonBody(req);
      const credits = Number(body?.credits);
      if (!Number.isInteger(credits) || credits < 0) {
        return sendError(res, 400, 'BAD_REQUEST', 'Nombre de crédits invalide.');
      }
      return sendJson(res, 200, { user: setPurchasedCredits(userId, credits) });
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
loadAccounts();
server.listen(PORT, () => {
  console.log(`[relay] signalisation WS + /api sur http://localhost:${PORT}${existsSync(join(DIST, 'index.html')) ? ' (sert aussi dist/)' : ''}`);
});

