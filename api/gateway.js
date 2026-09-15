// api/gateway.js — Vercel serverless LLM proxy (catch-all /api/*)
//
// Reçoit les requêtes du frontend en chemins relatifs (/api/...) et les
// transmet au provider LLM configuré côté serveur (.env) ou côté client
// (en-têtes X-LLM-* pour le mode BYOK).

// Pas d'export `config` : le runtime Node.js est le défaut pour /api, et ce
// champ n'accepte de toute façon que 'edge' | 'experimental-edge' | 'nodejs' —
// jamais une version. La VERSION de Node se règle dans `engines.node` du
// package.json (ou dans les réglages du projet Vercel), pas ici.

function sendError(status, code, message) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function getServerConfig() {
  const baseUrl = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY || '';
  const model = process.env.LLM_MODEL || '';
  const temperature = process.env.LLM_TEMPERATURE || '0.9';
  return { baseUrl, apiKey, model, temperature };
}

async function handleHealth() {
  const { baseUrl, model, temperature } = getServerConfig();
  return new Response(JSON.stringify({
    ok: true,
    provider: baseUrl,
    model,
    temperature: parseFloat(temperature),
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Plages réservées qu'une URL fournie par le client ne doit jamais atteindre :
// sinon la fonction devient un proxy ouvert vers le réseau interne de l'hôte.
const BLOCKED_HOSTNAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

function isPrivateAddress(host) {
  // IPv6 littéral entre crochets
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

/**
 * Valide une base d'URL FOURNIE PAR LE CLIENT (mode BYOK). Renvoie un message
 * d'erreur, ou null si l'URL est acceptable.
 *
 * Défense en profondeur, pas une garantie : un nom d'hôte public qui résout vers
 * une adresse privée (DNS rebinding) passerait ce filtre. Pour aller plus loin il
 * faudrait résoudre le nom et revalider l'IP avant connexion.
 */
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

async function handleChat(request) {
  const { baseUrl: serverBaseUrl, apiKey: serverApiKey, model: serverModel } = getServerConfig();

  // Lecture du body client
  let body;
  try {
    body = await request.text();
  } catch {
    return sendError(400, 'EMPTY_BODY', 'Corps de requête vide.');
  }
  if (!body) return sendError(400, 'EMPTY_BODY', 'Corps de requête vide.');

  // Config effective : BYOK prime sur serveur
  const clientBaseUrl = String(request.headers.get('x-llm-base-url') || '').trim().replace(/\/+$/, '');
  const clientApiKey = String(request.headers.get('x-llm-api-key') || '').trim();
  // Seule l'URL venant du client est filtrée : celle du .env est choisie par
  // l'exploitant, qui a le droit de viser un service interne.
  if (clientBaseUrl) {
    const refus = rejectUnsafeUpstream(clientBaseUrl);
    if (refus) return sendError(400, 'UNSAFE_LLM_BASE_URL', refus);
  }

  const effectiveBaseUrl = clientBaseUrl || serverBaseUrl;
  const effectiveApiKey = clientApiKey || serverApiKey;

  if (!effectiveBaseUrl || !effectiveApiKey) {
    return sendError(500, 'MISSING_LLM_CONFIG',
      'Configuration LLM manquante. Renseignez vos identifiants ou configurez le serveur.');
  }

  // Forward headers sauf cookie + hôte
  const forwardHeaders = new Headers();
  forwardHeaders.set('Content-Type', 'application/json');
  forwardHeaders.set('Authorization', `Bearer ${effectiveApiKey}`);

  // Injecter le modèle serveur si absent du body
  let forwardedBody = body;
  try {
    const parsed = JSON.parse(body);
    if (!parsed.model) parsed.model = serverModel;
    forwardedBody = JSON.stringify(parsed);
  } catch { /* forward tel quel */ }

  // Requête vers le provider
  const targetUrl = `${effectiveBaseUrl}/chat/completions`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 30_000);

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method: 'POST',
      headers: forwardHeaders,
      body: forwardedBody,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(tid);
    if (err.name === 'AbortError') {
      return sendError(504, 'UPSTREAM_TIMEOUT', 'Le provider LLM n\'a pas répondu en 30 s.');
    }
    return sendError(502, 'UPSTREAM_UNREACHABLE', `Impossible de joindre le provider (${targetUrl}).`);
  }
  clearTimeout(tid);

  const responseBody = await upstreamResponse.text();

  // Garde-fou : pas de fuite de clé
  if (effectiveApiKey && responseBody.includes(effectiveApiKey)) {
    console.error('[quizz-canape] ALERTE: la réponse upstream contient la clé API !');
  }

  const responseHeaders = new Headers();
  const ct = upstreamResponse.headers.get('content-type') || 'application/json';
  responseHeaders.set('Content-Type', ct);

  return new Response(responseBody, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}

async function handler(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '');

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-LLM-Base-URL, X-LLM-Api-Key',
      },
    });
  }

  if (request.method === 'GET' && path === 'health') {
    return handleHealth();
  }

  if (request.method === 'POST' && path === 'chat/completions') {
    return handleChat(request);
  }

  return sendError(404, 'NOT_FOUND', `Route inconnue : ${path}`);
}

// Export « fetch Web Standard », l'une des trois signatures que Vercel reconnaît
// dans /api. Une fonction exportée par défaut serait traitée comme le handler
// Node (request, response) : ce code recevrait alors un IncomingMessage, sur
// lequel `headers.get()` n'existe pas et `url` est relative — et le Response
// renvoyé serait ignoré.
export default { fetch: handler };