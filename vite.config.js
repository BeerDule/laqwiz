// vite.config.js
import { defineConfig, loadEnv } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Version affichée, en semver : `<version de package.json>+<sha court>`.
 *
 * Le SHA est accolé en MÉTADONNÉE DE BUILD (`+`) et non en identifiant de
 * pré-version (`.`), pour deux raisons :
 *
 *  - c'est ce que la spec prévoit pour un numéro de build ou un commit ;
 *  - un identifiant de pré-version purement numérique ne peut pas commencer par
 *    zéro. Un SHA court comme `0123456` rendrait donc `0.1.0-beta.0123456`
 *    INVALIDE, alors que `0.1.0-beta+0123456` reste correct. Environ un commit
 *    sur trois cents tombe dans ce cas — trop rare pour être vu en test, assez
 *    fréquent pour casser un jour.
 *
 * La métadonnée de build est par ailleurs ignorée dans les comparaisons de
 * précédence, ce qui est le comportement voulu : deux builds du même
 * `0.1.0-beta` sont la même version, quel que soit le commit.
 *
 * Le SHA est cherché dans cet ordre, parce qu'aucune source n'est disponible
 * partout :
 *   1. VERCEL_GIT_COMMIT_SHA — fourni par Vercel, dont le conteneur de build
 *      n'a pas forcément `git` ;
 *   2. `git rev-parse` — en local, quand git est dans le PATH (ce n'est pas le
 *      cas par défaut dans le shell Nix du projet) ;
 *   3. aucune — on renvoie la version nue, qui reste du semver valide.
 */
function resolveVersion() {
  const base = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version;
  const fromVercel = process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromVercel) return `${base}+${fromVercel.slice(0, 7)}`;
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (sha) return `${base}+${sha}`;
  } catch { /* ni Vercel ni git : on continue */ }
  return base;
}

/**
 * Plugin Vite : proxy LLM OpenAI-compatible.
 * - Le navigateur appelle uniquement des URLs relatives (/api/...).
 * - Le serveur réécrit vers le provider (URL + clé fournies par le client
 *   via en-têtes X-LLM-* ou, à défaut, par le .env serveur).
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
    // Le .env reste facultatif : chaque client peut fournir sa propre
    // configuration (URL + clé + modèle) depuis l'écran de configuration.
    if (!baseUrl || !apiKey || !model) {
      console.warn(
        '[quizz-canape] .env incomplet : le serveur utilisera la ' +
        'configuration LLM fournie côté client (BYOK).'
      );
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

        // --- Config effective : celle du client (BYOK) prime sur celle du .env ---
        const clientBaseUrl = String(req.headers['x-llm-base-url'] || '')
          .trim().replace(/\/+$/, '');
        const clientApiKey = String(req.headers['x-llm-api-key'] || '').trim();
        const effectiveBaseUrl = clientBaseUrl || baseUrl;
        const effectiveApiKey = clientApiKey || apiKey;

        if (!effectiveBaseUrl || !effectiveApiKey) {
          return sendError(res, 500, 'MISSING_LLM_CONFIG',
            'Configuration LLM manquante : renseignez l\'URL et la clé API ' +
            'côté client (écran de configuration) ou dans .env.');
        }
        if (!/^https?:\/\//i.test(effectiveBaseUrl)) {
          return sendError(res, 400, 'INVALID_BASE_URL',
            'URL du provider LLM invalide (doit commencer par http:// ou https://).');
        }

        // --- Headers sortants : on injecte Authorization, on nettoie le reste ---
        const forwardHeaders = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${effectiveApiKey}`,
          'Accept': req.headers['accept'] || 'application/json',
        };

        // --- Modèle : celui du client prime ; sinon on reprend celui du .env ---
        let forwardedBody;
        try {
          const parsed = JSON.parse(rawBody);
          if (!parsed.model) parsed.model = model;
          forwardedBody = JSON.stringify(parsed);
        } catch {
          forwardedBody = rawBody; // en cas d'échec de parse, on forward tel quel
        }

        // --- Requête vers le provider ---
        const targetUrl = `${effectiveBaseUrl}${req.url}`;
        const controller = new AbortController();
        const timeoutMs = 35_000; // légèrement > timeout client (30s)
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        let upstreamResponse;
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

        // --- Lecture de la réponse upstream ---
        const responseBody = await upstreamResponse.text();
        const responseHeaders = {
          'Content-Type':
            upstreamResponse.headers.get('content-type') || 'application/json',
        };

        // --- Garde-fou : s'assure que la clé ne fuite PAS ---
        if (responseBody.includes(effectiveApiKey)) {
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

  // LLM_CONFIG_REQUIRED — faut-il que chaque joueur saisisse ses propres
  // identifiants LLM (mode BYOK) ?
  //   'false' → non : le serveur fournit la configuration via .env
  //   'true'  → oui, même en développement
  //   absent  → obligatoire en production, optionnel en développement
  //
  // Injectée par `define` et non via un préfixe VITE_ : le nom reste aligné sur
  // les autres LLM_*. Comme toute valeur `define`, elle est FIGÉE À LA
  // COMPILATION — la changer impose de rebuilder, ce n'est pas un interrupteur.
  const requireLlmConfig = env.LLM_CONFIG_REQUIRED === undefined || env.LLM_CONFIG_REQUIRED === ''
    ? command === 'build'
    : env.LLM_CONFIG_REQUIRED !== 'false';

  return {
    root: '.',
    base: './', // §16.3 : assets en chemins relatifs, portables sous n'importe quel sous-chemin
    define: {
      __REQUIRE_LLM_CONFIG__: JSON.stringify(requireLlmConfig),
      // Figée à la compilation, comme toute valeur `define` : un déploiement
      // porte donc le SHA du commit qui l'a produit.
      __APP_VERSION__: JSON.stringify(resolveVersion()),
    },
    publicDir: 'public',
    server: {
      port: 5173,
      strictPort: false,
      host: true, // exposé en LAN pour jouer sur TV
    },
    build: {
      target: 'es2022',
      outDir: 'dist',
      // Dev uniquement : en production c'était 211 Ko de sourcemap servis
      // publiquement pour rien.
      sourcemap: command === 'serve',
      cssCodeSplit: false,
    },
    plugins: [llmProxyPlugin(env, { validate: command === 'serve' })],
  };
});
