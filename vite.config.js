// vite.config.js
import { defineConfig, loadEnv } from 'vite';

/**
 * Plugin Vite : proxy LLM OpenAI-compatible.
 * - Le navigateur appelle uniquement des URLs relatives (/api/...).
 * - Le serveur réécrit vers LLM_BASE_URL et injecte Authorization.
 * - La clé API n'est JAMAIS envoyée au navigateur.
 */
function llmProxyPlugin(env, { validate } = {}) {
  const baseUrl = (env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = env.LLM_API_KEY || '';
  const model = env.LLM_MODEL || '';
  const temperature = env.LLM_TEMPERATURE || '0.9';
  const batchSize = env.LLM_BATCH_SIZE || '5';

  // Validation au chargement du plugin, uniquement en mode dev (`vite dev`).
  // `vite build` ne démarre pas de serveur : le build statique n'a pas de
  // proxy (§16.2), donc il doit réussir même sans `.env` (pas de clé requise).
  if (validate) {
    if (!baseUrl) {
      throw new Error(
        '[quizz-canape] LLM_BASE_URL manquant dans .env. ' +
        'Copiez .env.example vers .env et renseignez la valeur.'
      );
    }
    if (!apiKey) {
      throw new Error(
        '[quizz-canape] LLM_API_KEY manquant dans .env. ' +
        'Cette clé ne doit JAMAIS être préfixée VITE_.'
      );
    }
    if (!model) {
      throw new Error('[quizz-canape] LLM_MODEL manquant dans .env.');
    }
  }

  function sendError(res, status, code, message) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { code, message } }));
  }

  return {
    name: 'quizz-canape-llm-proxy',
    configureServer(server) {
      // Petit endpoint de santé (GET /api/health) — enregistré AVANT /api
      // car `use('/api', ...)` matche aussi /api/health par préfixe.
      server.middlewares.use('/api/health', (req, res) => {
        if (req.method !== 'GET') {
          return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'GET only.');
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          ok: true,
          provider: baseUrl,
          model,
          temperature: parseFloat(temperature),
          batchSize: parseInt(batchSize, 10),
          // JAMAIS la clé !
        }));
      });

      server.middlewares.use('/api', async (req, res) => {
        // --- Garde-fous ---
        if (req.method !== 'POST') {
          return sendError(res, 405, 'METHOD_NOT_ALLOWED',
            `Seule la méthode POST est autorisée sur /api (reçu ${req.method}).`);
        }
        if (!req.url || req.url === '/' || req.url === '') {
          return sendError(res, 400, 'MISSING_PATH',
            'Chemin LLM manquant (attendu : /api/chat/completions).');
        }

        // --- Lecture du body ---
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const rawBody = Buffer.concat(chunks).toString('utf8');
        if (!rawBody) {
          return sendError(res, 400, 'EMPTY_BODY', 'Corps de requête vide.');
        }

        // --- Headers sortants : on injecte Authorization, on nettoie le reste ---
        const forwardHeaders = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': req.headers['accept'] || 'application/json',
        };

        // --- Injection du modèle serveur : le client ne choisit pas le modèle,
        //     c'est le .env qui décide. On remplace le champ "model" du body. ---
        let forwardedBody;
        try {
          const parsed = JSON.parse(rawBody);
          parsed.model = model;
          forwardedBody = JSON.stringify(parsed);
        } catch {
          forwardedBody = rawBody; // en cas d'échec de parse, on forward tel quel
        }

        // --- Requête vers le provider ---
        const targetUrl = `${baseUrl}${req.url}`;
        const controller = new AbortController();
        const timeoutMs = 35_000; // légèrement > timeout client (30s)
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        let upstreamResponse;
        const startMs = Date.now();
        try {
          upstreamResponse = await fetch(targetUrl, {
            method: 'POST',
            headers: forwardHeaders,
            body: forwardedBody,
            signal: controller.signal,
          });
        } catch (err) {
          clearTimeout(timeoutId);
          if (err.name === 'AbortError') {
            return sendError(res, 504, 'UPSTREAM_TIMEOUT',
              `Le provider LLM n'a pas répondu en ${timeoutMs} ms.`);
          }
          return sendError(res, 502, 'UPSTREAM_UNREACHABLE',
            `Impossible de joindre le provider LLM (${targetUrl}).`);
        }
        clearTimeout(timeoutId);
        const elapsedMs = Date.now() - startMs;

        // --- Lecture de la réponse upstream ---
        const responseBody = await upstreamResponse.text();
        const responseHeaders = {
          'Content-Type':
            upstreamResponse.headers.get('content-type') || 'application/json',
        };

        // --- Garde-fou : s'assure que la clé ne fuite PAS ---
        if (responseBody.includes(apiKey)) {
          server.config.logger.error(
            '[llm-proxy] ALERTE: la réponse upstream contient la clé API !'
          );
        }

        // --- Réponse au navigateur : on masque certains détails upstream ---
        res.statusCode = upstreamResponse.status;
        Object.entries(responseHeaders).forEach(([k, v]) => res.setHeader(k, v));
        // Headers à supprimer pour éviter toute fuite d'info interne
        res.removeHeader('set-cookie');
        res.removeHeader('www-authenticate');
        res.end(responseBody);
      });
    },
  };
}

export default defineConfig(({ mode, command }) => {
  // Charge TOUTES les variables (chaîne vide = pas de filtre de préfixe).
  // C'est ici qu'on lit .env serveur uniquement.
  const env = loadEnv(mode, process.cwd(), '');

  // Valeurs normalisées avec défauts
  const temperature = parseFloat(env.LLM_TEMPERATURE);
  const batchSize = parseInt(env.LLM_BATCH_SIZE, 10);

  if (Number.isNaN(temperature) || temperature < 0 || temperature > 2) {
    env.LLM_TEMPERATURE = '0.9';
  } else {
    env.LLM_TEMPERATURE = String(temperature);
  }

  if (
    Number.isNaN(batchSize) ||
    batchSize < 1 ||
    batchSize > 20 ||
    !Number.isInteger(batchSize)
  ) {
    env.LLM_BATCH_SIZE = '5';
  } else {
    env.LLM_BATCH_SIZE = String(batchSize);
  }

  return {
    root: '.',
    base: './', // §16.3 : assets en chemins relatifs, portables sous n'importe quel sous-chemin
    publicDir: 'public',
    server: {
      port: 5173,
      strictPort: false,
      host: true, // exposé en LAN pour jouer sur TV
    },
    build: {
      target: 'es2022',
      outDir: 'dist',
      sourcemap: true,
      cssCodeSplit: false,
    },
    plugins: [llmProxyPlugin(env, { validate: command === 'serve' })],
  };
});
