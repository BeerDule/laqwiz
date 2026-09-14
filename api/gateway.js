// api/gateway.js — Vercel serverless LLM proxy (catch-all /api/*)
//
// Reçoit les requêtes du frontend en chemins relatifs (/api/...) et les
// transmet au provider LLM configuré côté serveur (.env) ou côté client
// (en-têtes X-LLM-* pour le mode BYOK).

export const config = { runtime: 'nodejs20.x' };

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

export default async function handler(request) {
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