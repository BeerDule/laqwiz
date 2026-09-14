// api.js — client HTTP vers /api (proxy) avec retries, timeout, backoff (SPEC §7).
import { getState } from './state.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { parseQuestions, normalizeQuestionText } from './validation.js';
import { QUESTION_SCHEMA_JSON } from './constants.js';

/**
 * Codes d'erreur normalisés pour la couche UI.
 */
export class ApiError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'ApiError';
    this.code = code; // TIMEOUT | NETWORK | INVALID_JSON | INCOMPLETE_BATCH
                      // | UPSTREAM_4XX | UPSTREAM_5XX | AUTH
    this.cause = cause;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options, timeoutMs = 30_000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/**
 * Extrait un objet JSON d'une chaîne pouvant contenir du texte avant/après,
 * des fences markdown, des commentaires ou des virgules trailing.
 * Retourne { json, method } ou { error }.
 */
function extractJson(raw) {
  if (typeof raw !== 'string') return { error: 'not a string' };
  let s = raw.trim();

  // 1. Fences markdown ```json ... ``` ou ``` ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) s = fence[1].trim();

  // 2. Nettoyage des backticks simples
  s = s.replace(/^`+|`+$/g, '').trim();

  // 3. Découpage sur la première { et la dernière } pour tolérer du texte autour
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return { error: 'no JSON object found' };
  }
  s = s.slice(firstBrace, lastBrace + 1);

  // 4. Tentatives de parse avec corrections douces
  const attempts = [s, stripComments(s), stripTrailingCommas(s)];
  for (const candidate of attempts) {
    try {
      return { json: JSON.parse(candidate), method: 'parse' };
    } catch { /* continue */ }
  }
  return { error: 'all parse attempts failed' };
}

function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function stripTrailingCommas(s) {
  return s.replace(/,(\s*[\]}])/g, '$1');
}

/**
 * Mappe une erreur (ApiError ou autre) vers un objet { code, message } lisible.
 */
export function toUiError(error) {
  const code = error?.code || 'UNKNOWN';
  const messages = {
    TIMEOUT: { code, message: 'Le provider est trop lent. Réessayez.' },
    NETWORK: { code, message: 'Provider LLM injoignable.' },
    INVALID_JSON: { code, message: 'Le LLM a répondu dans un format inattendu.' },
    INCOMPLETE_BATCH: { code, message: 'Aucune question valide reçue.' },
    UPSTREAM_4XX: { code, message: 'Trop de demandes ; nouvel essai possible.' },
    UPSTREAM_5XX: { code, message: 'Le service de questions est indisponible.' },
    AUTH: { code, message: 'Clé LLM refusée. Vérifiez votre configuration serveur.' },
  };
  return messages[code] || {
    code: 'UNKNOWN',
    message: 'Une erreur est survenue. Réessayez ou rechargez.',
  };
}

const MAX_JSON_TRIES = 3; // 1 tentative + 2 retries silencieux
const RATE_LIMIT_DELAYS = [2000, 4000, 8000];

/**
 * Demande un lot de questions au LLM via le proxy /api.
 * @throws {ApiError} en cas d'échec définitif après retries.
 */
export async function fetchQuestionBatch({ theme, batchSize, exclude = [] }) {
  const settings = getState().settings;
  const systemPrompt = buildSystemPrompt({
    theme, batchSize, history: exclude, schemaJSON: QUESTION_SCHEMA_JSON,
  });
  const userPrompt = buildUserPrompt({ theme, batchSize, history: exclude });

  const body = {
    model: settings.model,
    temperature: settings.temperature,
    response_format: { type: 'json_object' },
    max_tokens: 4096,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };

  async function requestOnce() {
    try {
      return await fetchWithTimeout('/api/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 30_000);
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new ApiError('TIMEOUT', 'La requête a dépassé 30 s.');
      }
      throw new ApiError('NETWORK', err.message || 'Erreur réseau inconnue', err);
    }
  }

  let jsonTries = 0;
  let rateLimitTries = 0;

  while (true) {
    // --- Requête (avec 1 retry réseau après 1 s) ---
    let res;
    try {
      res = await requestOnce();
    } catch (err) {
      if (err.code === 'TIMEOUT') throw err; // pas de retry
      if (err.code === 'NETWORK') {
        await sleep(1000);
        res = await requestOnce(); // si échec, NETWORK remonte
      } else {
        throw err;
      }
    }

    // --- 429 : backoff exponentiel 2 s / 4 s / 8 s ---
    if (res.status === 429) {
      if (rateLimitTries >= RATE_LIMIT_DELAYS.length) {
        throw new ApiError('UPSTREAM_4XX',
          'Trop de demandes ; nouvel essai possible.', res.status);
      }
      await sleep(RATE_LIMIT_DELAYS[rateLimitTries++]);
      continue;
    }

    // --- 401 / 403 : clé invalide, aucun retry ---
    if (res.status === 401 || res.status === 403) {
      throw new ApiError('AUTH',
        `Authentification refusée (HTTP ${res.status}). Vérifiez LLM_API_KEY dans .env.`);
    }

    // --- 5xx : un retry après 2 s ---
    if (res.status >= 500) {
      await sleep(2000);
      res = await requestOnce();
      if (res.status >= 500) {
        throw new ApiError('UPSTREAM_5XX', `Provider indisponible (HTTP ${res.status}).`);
      }
      if (res.status === 429) {
        if (rateLimitTries >= RATE_LIMIT_DELAYS.length) {
          throw new ApiError('UPSTREAM_4XX',
            'Trop de demandes ; nouvel essai possible.', res.status);
        }
        await sleep(RATE_LIMIT_DELAYS[rateLimitTries++]);
        res = await requestOnce();
      }
      if (res.status === 401 || res.status === 403) {
        throw new ApiError('AUTH',
          `Authentification refusée (HTTP ${res.status}). Vérifiez LLM_API_KEY dans .env.`);
      }
      if (!res.ok) {
        throw new ApiError('UPSTREAM_4XX', `Réponse inattendue (HTTP ${res.status}).`);
      }
    } else if (!res.ok) {
      throw new ApiError('UPSTREAM_4XX', `Réponse inattendue (HTTP ${res.status}).`);
    }

    // --- Lecture du JSON upstream ---
    const text = await res.text();
    let envelope = null;
    try { envelope = JSON.parse(text); } catch { /* sera traité en INVALID_JSON */ }
    const assistant = envelope?.choices?.[0]?.message?.content;
    if (typeof assistant !== 'string' || !assistant.trim()) {
      if (++jsonTries >= MAX_JSON_TRIES) {
        throw new ApiError('INVALID_JSON', 'Réponse LLM vide.');
      }
      continue;
    }

    // --- Extraction défensive ---
    const extracted = extractJson(assistant);
    if (extracted.error) {
      if (++jsonTries >= MAX_JSON_TRIES) {
        throw new ApiError('INVALID_JSON', extracted.error);
      }
      continue;
    }

    // --- Validation contrat ---
    const parsed = parseQuestions(extracted.json);
    if (!parsed.questions.length) {
      if (++jsonTries >= MAX_JSON_TRIES) {
        throw new ApiError('INVALID_JSON',
          `0 question valide. Erreurs: ${parsed.errors.join(' | ')}`);
      }
      continue;
    }

    // --- Anti-doublon côté client (externe + interne au lot) ---
    const seen = new Set(exclude.map(normalizeQuestionText));
    const localSeen = new Set();
    const finalQuestions = parsed.questions.filter(q => {
      const key = normalizeQuestionText(q.question);
      if (seen.has(key) || localSeen.has(key)) return false;
      localSeen.add(key);
      return true;
    });

    // Si tout est doublon, on garde pour ne pas boucler (idem SPEC §7.6)
    const outQuestions = finalQuestions.length ? finalQuestions : parsed.questions;
    return {
      questions: outQuestions,
      errors: parsed.errors,
      raw: undefined,
    };
  }
}

