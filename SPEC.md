# SPEC — Canap' QuiZZ

> Spécification technique du MVP, écrite **avant** implémentation.
> Stack imposée : Vite + Vanilla JS / HTML / CSS. Provider LLM générique OpenAI-compatible.

> **État du document.** Les sections 6, 7, 8, 10, 11 et 13 (contrat `Question`, `api.js`,
> `prompt.js`, scoring, préchargement, design system) décrivent toujours le code en place.
> Les sections 3, 9, 12, 14 et 16 ont été remises à jour et font foi.
>
> En revanche, le produit a dépassé ce document sur trois axes qui n'y ont **jamais** été
> spécifiés : la hiérarchie **session / partie / manche**, l'archive **IndexedDB** et la
> **source Wikipédia**. Pour ceux-là, `AGENTS.md` fait autorité, pas ce fichier.

---

## Table des matières

1. [Objectif, périmètre et non-goals](#1-objectif-périmètre-et-non-goals)
2. [Stack et versions](#2-stack-et-versions)
3. [Arborescence des fichiers](#3-arborescence-des-fichiers)
4. [Configuration et variables d'environnement](#4-configuration-et-variables-denvironnement)
5. [`vite.config.js` — proxy serveur](#5-viteconfigjs--proxy-serveur)
6. [Contrat de données — `Question`](#6-contrat-de-données--question)
7. [Module `api.js`](#7-module-apijs)
8. [Module `prompt.js`](#8-module-promptjs)
9. [Module `state.js`](#9-module-statejs)
10. [Logique de scoring](#10-logique-de-scoring)
11. [Préchargement des questions](#11-préchargement-des-questions)
12. [Écrans](#12-écrans)
13. [Design system](#13-design-system)
14. [`localStorage`](#14-localstorage)
15. [Gestion d'erreurs](#15-gestion-derreurs)
16. [`package.json` et déploiement](#16-packagejson-et-déploiement)
17. [Critères d'acceptation testables](#17-critères-dacceptation-testables)
18. [Checklist d'implémentation par phases](#18-checklist-dimplémentation-par-phases)

---

## 1. Objectif, périmètre et non-goals

### 1.1. Objectif produit

**Quizz Canapé** est un jeu de quiz multijoueur **local**, joué sur un seul écran partagé (TV, projecteur, laptop grand format), dans un cadre domestique (« soirée canapé »). Un utilisateur — le **maître du jeu** (MJ) — saisit physiquement les réponses des autres joueurs au clavier. Les questions sont **générées à la volée par un LLM** sur un thème librement choisi. Chaque question propose **4 propositions dont une est volontairement drôle** (jamais la bonne réponse).

### 1.2. Périmètre fonctionnel

| # | Capacité | Inclus |
|---|----------|--------|
| F1 | Saisie de 2 à 6 joueurs avec prénom + emoji + couleur auto | ✅ |
| F2 | Choix d'un thème parmi 8 suggestions ou champ libre | ✅ |
| F3 | Paramétrage : score cible (5-30, défaut 15), règle « 2 pts d'écart », question bonus double points | ✅ |
| F4 | Génération de questions par LLM via proxy serveur | ✅ |
| F5 | Affichage séquentiel d'une question à la fois | ✅ |
| F6 | Saisie maître du jeu des réponses A/B/C/D pour chaque joueur | ✅ |
| F7 | Révélation de la bonne réponse, de l'option drôle, et d'une explication courte | ✅ |
| F8 | Mise à jour des scores en temps réel | ✅ |
| F9 | Écran de victoire avec podium, confettis, récapitulatif | ✅ |
| F10 | Persistance `localStorage` des joueurs, paramètres et statistiques | ✅ |
| F11 | Préchargement invisible des questions (zéro attente après la première) | ✅ |
| F12 | Accessibilité AA, contraste, focus, `prefers-reduced-motion`, cibles ≥ 44 px | ✅ |
| F13 | Design responsive (mobile portrait → TV 4K) | ✅ |
| F14 | Rejouer sans recharger la page | ✅ |
| F15 | Provider LLM interchangeable (Mammouth par défaut, OpenRouter/Groq/Ollama compatibles) | ✅ |

### 1.3. Acteurs

| Acteur | Rôle |
|--------|------|
| **Maître du jeu** (MJ) | Pilote l'app, saisit les réponses au clavier, gère l'écran |
| **Joueurs** (2 à 6) | Réfléchissent, proposent une réponse A/B/C/D à l'oral, le MJ valide |
| **LLM provider** | Génère les questions via API OpenAI-compatible, contacté **uniquement côté serveur** |

### 1.4. Non-goals (hors périmètre MVP)

- ❌ Multijoueur en ligne / réseau / WebSocket
- ❌ Comptes utilisateurs, authentification
- ❌ Base de données serveur
- ❌ Paiement, leaderboard mondial, classement persistant multi-device
- ❌ Éditeur visuel de thèmes ou de questions
- ❌ Mode hors-ligne sans LLM local (Ollama *peut* être utilisé si l'utilisateur l'installe, mais ce n'est pas un livrable)
- ❌ Application mobile native (le MVP est une PWA-friendly web app)
- ❌ Internationalisation (le MVP est **français uniquement**)
- ❌ Génération d'images, audio, vidéo pour les questions
- ❌ Streaming token-par-token des questions (réponse complète ou erreur)

---

## 2. Stack et versions

### 2.1. Versions imposées

| Composant | Version | Justification courte |
|-----------|---------|----------------------|
| **Node.js** | ≥ 20 LTS | Support natif `fetch`, `AbortController`, top-level await côté tooling |
| **Vite** | ^5.4 | Dev server avec proxy HTTP programmable, build ESM moderne, HMR rapide |
| **JavaScript** | ES2022 natif | Pas de transpileur nécessaire ; classes, optional chaining, top-level await |
| **HTML** | HTML5 sémantique | `<main>`, `<section>`, `<button>`, `<dialog>` |
| **CSS** | CSS3 + custom properties + `@layer` | Pas de préprocesseur, variables pour le design system |
| **Police** | Google Fonts : Outfit ou Space Grotesk | Chargée via `<link>` avec `font-display: swap` |
| **Stockage** | `localStorage` natif | Pas de dépendance, schémas JSON versionnés |
| **LLM SDK** | **Aucun SDK** — `fetch` natif uniquement | Compatibilité totale OpenAI-compatible, zéro dépendance tierce pour l'API |

### 2.2. Dépendances npm

```json
{
  "devDependencies": {
    "vite": "^5.4.0"
  },
  "dependencies": {}
}
```

**Aucune dépendance runtime.** Pas de framework UI, pas de state manager, pas de router, pas de date-fns, pas de lodash. Tout est vanilla.

### 2.3. Justifications

| Décision | Pourquoi |
|----------|----------|
| Vanilla JS plutôt que React/Vue | App ≤ 5 écrans, état simple, bundle final < 50 kB, zéro build complexe |
| Vite plutôt que CRA / Next | Proxy HTTP programmable via plugin, support `.env` serveur (`loadEnv`), HMR instantané |
| Pas de SDK OpenAI | `fetch` + JSON ; Mammouth, OpenRouter, Groq, Ollama exposent toutes le même endpoint `/chat/completions` |
| Police web plutôt que locale | Évite ~200 kB de binaire ; `font-display: swap` garantit FOUT acceptable |
| CSS custom properties plutôt que Tailwind | Contrôle total du thème, pas de purge nécessaire, debug direct DevTools |

### 2.4. Pré-requis développeur

- Node 20 LTS installé
- Un compte chez un provider OpenAI-compatible (Mammouth par défaut) avec une clé API
- Un terminal + un navigateur moderne (Chrome 120+, Firefox 120+, Safari 17+)

---

## 3. Arborescence des fichiers

```
quizz-canape/
├── .env                          # NON versionné (gitignored)
├── .env.example                  # Modèle versionné
├── .githooks/
│   ├── pre-commit                # incrémente le patch sur `dev` (voir AGENTS.md)
│   └── bump-patch.mjs
├── AGENTS.md                     # guide de travail — fait autorité sur ce fichier
├── SPEC.md                       # Ce document
├── package.json
├── vite.config.js                # build + proxy LLM du serveur de DEV
├── vercel.json                   # rewrites : /api/* → /api/gateway
├── flake.nix                     # shell reproductible
├── index.html
├── api/
│   └── gateway.js                # proxy LLM serverless (production)
├── demo/
│   └── mock-llm.mjs              # faux LLM OpenAI-compatible, zéro dépendance
├── public/
│   └── bubble-island/            # sprites découpés du pack craft/
└── src/
    ├── main.js                   # bootstrap, hydratation, routage, toasts
    ├── state.js                  # store + pub/sub + machine à états
    ├── api.js                    # client HTTP vers /api (proxy)
    ├── prompt.js                 # prompts système / utilisateur
    ├── storage.js                # wrappers localStorage typés
    ├── db.js                     # IndexedDB : sessions, parties, reprises, modes
    ├── modes.js                  # modes de jeu : semis versionné, CRUD, diff
    ├── wikipedia.js              # recherche et fenêtre de sections
    ├── shareConfig.js            # config LLM encodée en URL (base64url)
    ├── themeSwitcher.js          # thème de couleurs (data-color-theme)
    ├── confetti.js               # animation canvas victoire
    ├── validation.js             # validateQuestion(), parseQuestions()
    ├── constants.js              # avatars, couleurs, BUILTIN_MODES, DEFAULTS, STORAGE_KEYS
    ├── components/
    │   └── playerChip.js         # jeton de joueur avec info-bulle
    ├── screens/
    │   ├── home.js               # menu principal
    │   ├── setup.js              # roster, thème, modes, règles
    │   ├── game.js               # question, saisie, révélation, chrono
    │   ├── victory.js            # podium + confettis
    │   ├── sessions.js           # gestionnaire de sessions
    │   └── settings.js           # réglages globaux de l'appareil
    └── styles/
        ├── theme.css             # jetons + 10 thèmes de couleurs
        ├── layout.css            # mise en page + garde [hidden]
        ├── components.css        # composants
        └── arcade.css            # coquille « jeu vidéo » (structure + jetons)
```

### 3.1. Responsabilités par fichier

| Fichier | Responsabilité unique | Public API |
|---------|----------------------|------------|
| `main.js` | Démarrage, routage d'écrans, hydratation | Aucun export, point d'entrée |
| `state.js` | Source de vérité de l'app | `getState()`, `subscribe(fn)`, `dispatch(action)` |
| `api.js` | I/O LLM avec retries | `fetchQuestionBatch({theme, batchSize, exclude})` |
| `prompt.js` | Construction des prompts | `buildSystemPrompt(…)`, `buildUserPrompt(…)` |
| `storage.js` | Persistance typée | `loadPlayers/savePlayers`, `loadSettings/saveSettings`, `loadStats/saveStats`, `loadLlmConfig/saveLlmConfig`, `clearAll()`, `wipeLocalStorage()` |
| `db.js` | Archive IndexedDB (avale ses erreurs) | `putSession/getSession/listSessions/deleteSession`, `putPartie/listParties/deletePartie`, `putResume/getResume/listResumes/deleteResume`, `listModes/putMode/deleteMode`, `clearArchive()` |
| `modes.js` | Modes de jeu | `loadModes()`, `createMode()`, `updateMode()`, `removeMode()`, `resetBuiltinMode()`, `diffFromMode()`, `sanitizeModeSettings()` |
| `wikipedia.js` | Source « article » | `parseArticleUrl()`, `searchArticles()`, `fetchArticle()`, `sectionWindow()` |
| `shareConfig.js` | Partage de config par URL | `encodeShareConfig()`, `decodeShareConfig()`, `buildShareUrl()` |
| `themeSwitcher.js` | Thème de couleurs | `initColorTheme()`, `setColorTheme()`, `getColorTheme()`, `renderThemeSelect()`, `wireThemeSelect()` |
| `confetti.js` | Animation DOM/canvas | `launchConfetti(…)`, `stopConfetti()` |
| `validation.js` | Validation contrat Question | `validateQuestion(q)`, `parseQuestions(json)` |
| `constants.js` | Valeurs constantes | `PLAYER_EMOJIS`, `PLAYER_EMOJI_LABELS`, `PLAYER_COLORS`, `PRESET_THEMES`, `BUILTIN_MODES`, `MODE_RULE_KEYS`, `DEFAULTS`, `STORAGE_KEYS`, `COLOR_THEMES` |
| `components/playerChip.js` | Jeton de joueur partagé | `playerChip(player, opts)`, `playerChips(list, opts)` |
| `screens/*.js` | Rendu + événements | `render<Écran>(root)`, `unmount<Écran>()` |
| `styles/*.css` | Présentation | Aucun |

### 3.2. Conventions de nommage

| Élément | Convention | Exemple |
|---------|-----------|---------|
| Fichiers JS | `kebab-case.js` | `state.js`, `validation.js` |
| Classes JS | `PascalCase` | `class GameScreen` |
| Fonctions | `camelCase` | `fetchQuestionBatch` |
| Constantes globales | `SCREAMING_SNAKE_CASE` | `STORAGE_KEYS`, `PRESET_THEMES` |
| Variables CSS | `--kebab-case` | `--color-accent-primary` |
| Selecteurs CSS | `kebab-case` + BEM léger | `.player-card`, `.player-card--active` |
| Attributs data | `data-kebab-case` | `data-screen="setup"` |
| IDs DOM | `kebab-case` avec namespace | `id="btn-start"`, `id="player-2"` |

---

## 4. Configuration et variables d'environnement

### 4.1. Variables

| Variable | Type | Défaut | Sensible ? | Description |
|----------|------|--------|-----------|-------------|
| `LLM_BASE_URL` | URL | `https://api.mammouth.ai/v1` | Non | Endpoint racine du provider, **sans** slash final |
| `LLM_API_KEY` | string | *(vide)* | **OUI** | Clé secrète du provider |
| `LLM_MODEL` | string | `mammouth-chat` | Non | Identifiant du modèle (ex: `gpt-4o-mini`, `llama-3.1-70b`, `mistral-large`) |
| `LLM_TEMPERATURE` | float ∈ [0, 2] | `0.9` | Non | Température de sampling. Plus haut = plus créatif/drôle |
| `LLM_BATCH_SIZE` | int ∈ [1, 20] | `5` | Non | Taille du lot de questions généré par appel API |

### 4.2. Règle d'or : PAS de préfixe `VITE_`

> ⚠️ **CRITIQUE** : Aucune de ces variables ne doit porter le préfixe `VITE_`.
> Les variables préfixées `VITE_` sont **inlinées dans le bundle JS** au build et **exposées au navigateur**.
> Ici, la clé API doit rester **strictement serveur**, lue uniquement par `vite.config.js` (plugin Node).

Le fichier `vite.config.js` utilise la fonction `loadEnv(mode, root, '')` (chaîne vide = pas de filtre de préfixe), ce qui permet de récupérer **toutes** les variables sans filtre.

### 4.3. Fichier `.env.example`

```dotenv
# Quizz Canapé — configuration LLM
# Copier ce fichier vers `.env` et renseigner les valeurs.

# URL racine du provider OpenAI-compatible (sans slash final)
# Défaut Mammouth ; autres exemples :
#   https://openrouter.ai/api/v1
#   https://api.groq.com/openai/v1
#   http://localhost:11434/v1          (Ollama local)
LLM_BASE_URL=https://api.mammouth.ai/v1

# Clé API du provider (JAMAIS versionnée, JAMAIS exposée au navigateur)
LLM_API_KEY=

# Identifiant du modèle à utiliser
LLM_MODEL=mammouth-chat

# Température de sampling (0 = déterministe, 2 = chaos)
LLM_TEMPERATURE=0.9

# Nombre de questions générées par appel API (recommandé : 5)
LLM_BATCH_SIZE=5
```

### 4.4. Fichier `.env` (NON versionné)

Le fichier `.env` est créé par le développeur à partir de `.env.example`. Il contient la clé réelle. **Il ne doit jamais être commité, ni打包é, ni transmis au navigateur**.

### 4.5. Fichier `.gitignore`

```gitignore
# Dépendances
node_modules/

# Variables d'environnement (CRITIQUE : contient la clé API)
.env
.env.*
!.env.example

# Build
dist/
dist-ssr/

# Logs
*.log
npm-debug.log*

# OS
.DS_Store
Thumbs.db

# Éditeurs
.idea/
.vscode/*
!.vscode/settings.json
!.vscode/extensions.json
```

### 4.6. Validation au démarrage

`vite.config.js` valide la présence des variables critiques au boot :

| Variable | Comportement si absente / invalide |
|----------|-----------------------------------|
| `LLM_BASE_URL` | Erreur fatale au démarrage de `vite` : message explicite |
| `LLM_API_KEY` | Erreur fatale ; le serveur refuse de démarrer |
| `LLM_MODEL` | Erreur fatale si vide |
| `LLM_TEMPERATURE` | Défaut `0.9` si non définie ou non numérique |
| `LLM_BATCH_SIZE` | Défaut `5` si non définie ou hors bornes `[1,20]` |

---

## 5. `vite.config.js` — proxy serveur

### 5.1. Rôle

`vite.config.js` est l'**unique point de contact** avec la clé API. Il :

1. Charge les variables d'environnement **serveur uniquement** via `loadEnv`.
2. Valide la configuration.
3. Expose un proxy `/api/*` qui :
   - Transfère les requêtes du navigateur vers `${LLM_BASE_URL}`.
   - **Injecte** le header `Authorization: Bearer ${LLM_API_KEY}`.
   - **Ne renvoie jamais** la clé au navigateur.
4. Gère les erreurs proxy (cible injoignable, 401, 429, 5xx) avec un statut normalisé.

### 5.2. Code complet de `vite.config.js`

```javascript
// vite.config.js
import { defineConfig, loadEnv } from 'vite';

/**
 * Plugin Vite : proxy LLM OpenAI-compatible.
 * - Le navigateur appelle uniquement des URLs relatives (/api/...).
 * - Le serveur réécrit vers LLM_BASE_URL et injecte Authorization.
 * - La clé API n'est JAMAIS envoyée au navigateur.
 */
function llmProxyPlugin(env) {
  const baseUrl = (env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = env.LLM_API_KEY || '';
  const model = env.LLM_MODEL || '';

  // Validation au chargement du plugin (donc au démarrage de `vite dev`)
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

  return {
    name: 'quizz-canape-llm-proxy',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res, next) => {
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
          // Optionnels propagés si présents côté client (utile pour streaming futur)
          'Accept': req.headers['accept'] || 'application/json',
        };

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
            body: rawBody,
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

        // --- Logging serveur uniquement (jamais côté navigateur) ---
        server.config.logger.info(
          `[llm-proxy] ${req.method} ${req.url} -> ` +
          `${upstreamResponse.status} (${elapsedMs} ms)`
        );

        // --- Sanity check : on s'assure que la clé ne fuite PAS ---
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

      // Petit endpoint de santé (GET /api/health) utile pour diagnostic
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
          // JAMAIS la clé !
        }));
      });
    },
  };
}

function sendError(res, status, code, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({
    error: { code, message },
  }));
}

export default defineConfig(({ mode }) => {
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
      rollupOptions: {
        output: {
          manualChunks: undefined,
        },
      },
    },
    plugins: [llmProxyPlugin(env)],
  };
});
```

### 5.3. Flux d'un appel LLM

```
[navigateur]  fetch('/api/chat/completions', { method:'POST', body:{...} })
     │
     ▼
[vite dev server]  middleware '/api' dans llmProxyPlugin
     │  1. valide méthode POST
     │  2. lit le body
     │  3. construit headers sortants { Authorization: Bearer ${LLM_API_KEY} }
     │  4. fetch(${LLM_BASE_URL}${req.url}, ...)
     │  5. copie la réponse au navigateur (jamais la clé)
     ▼
[provider LLM]  https://api.mammouth.ai/v1/chat/completions
     │
     ▼
[vite dev server]  res.statusCode = upstream.status ; res.end(body)
     │
     ▼
[navigateur]  reçoit le JSON, le parse, valide, affiche
```

### 5.4. Garanties de sécurité

| Risque | Mitigation |
|--------|-----------|
| Clé API exposée au navigateur | `loadEnv` lit `.env` uniquement côté Node ; aucun `import.meta.env.VITE_*` n'est utilisé |
| Clé API loggée dans la console navigateur | Le proxy n'envoie jamais la clé au client ; les logs serveur sont stderr uniquement |
| Forward de headers suspects | Seuls `Content-Type`, `Authorization`, `Accept` sont forwardés |
| Boucle infinie | Timeout 35 s côté proxy |
| `WWW-Authenticate` leaked | Suppression du header côté proxy |

---

## 6. Contrat de données — `Question`

### 6.1. Schéma JSON d'une Question

```jsonc
{
  "id": "q_1726000000_001",       // string, identifiant unique (timestamp + index)
  "theme": "cinéma",              // string, thème explicite de la question
  "difficulty": "medium",         // "easy" | "medium" | "hard"
  "question": "Quel film...",     // string, énoncé (1-2 phrases)
  "options": [
    { "key": "A", "text": "..." }, // exactement 4 entrées
    { "key": "B", "text": "..." },
    { "key": "C", "text": "..." },
    { "key": "D", "text": "..." }
  ],
  "answer": "B",                 // string ∈ {"A","B","C","D"} : bonne réponse
  "funnyOption": "D",            // string ∈ {"A","B","C","D"} : la réponse drôle (≠ answer)
  "explanation": "Parce que..."   // string, 1-3 phrases (max ~280 caractères)
}
```

### 6.2. Champs — contraintes strictes

| Champ | Type | Règles dures |
|-------|------|--------------|
| `id` | string | Non vide, unique dans la session, format recommandé `q_<ts>_<idx>` |
| `theme` | string | Non vide, ≤ 60 caractères |
| `difficulty` | enum | Exactement `"easy"`, `"medium"` ou `"hard"` |
| `question` | string | 10 ≤ len ≤ 240 caractères, finit par `?` |
| `options` | array | Exactement **4** entrées |
| `options[].key` | string | Exactement `"A"`, `"B"`, `"C"`, `"D"` dans cet ordre |
| `options[].text` | string | 1 ≤ len ≤ 120 caractères, non vide après `trim()` |
| `answer` | string | ∈ `{"A","B","C","D"}` |
| `funnyOption` | string | ∈ `{"A","B","C","D"}` ET **`!== answer`** |
| `explanation` | string | 20 ≤ len ≤ 280 caractères |

### 6.3. Règles additionnelles

| Règle | Détail |
|-------|--------|
| **Répartition aléatoire** | Sur un lot, `answer` ne doit pas être biaisé : distribution cible ≈ 25 % par clé. En aval, `validation.js` peut **réordonner** les options localement (mélange de Fisher-Yates) pour garantir l'équilibre visuel. |
| **Doublons** | Aucune question identique (même `question` normalisé) dans `historiqueDesQuestions`. |
| **Humour** | `funnyOption` ne doit PAS être offensant, politique, discriminatoire, sexuellement explicite ou vulgaire. (Filtré côté prompt + côté validation grossière : pas de mots interdits.) |
| **Ambiguïté** | `question` + `options` ne doivent pas avoir deux réponses défendables. La validation rejette toute question où plusieurs options contiennent des synonymes évidents de la bonne réponse. |

### 6.4. Pseudo-code `validateQuestion(q)`

```javascript
/**
 * Retourne { ok: boolean, errors: string[], normalized?: Question }
 * Si ok === true, `normalized` contient la question avec options potentiellement
 * réordonnées (mélange) pour répartir aléatoirement la position de `answer`.
 */
function validateQuestion(q, idx, opts = {}) {
  const errors = [];
  const rng = opts.rng || Math.random;

  // 1. Présence des champs
  if (!q || typeof q !== 'object') {
    return { ok: false, errors: ['objet invalide'] };
  }
  for (const field of ['id', 'theme', 'difficulty', 'question',
                       'options', 'answer', 'funnyOption', 'explanation']) {
    if (!(field in q)) errors.push(`champ manquant: ${field}`);
  }
  if (errors.length) return { ok: false, errors };

  // 2. Types
  if (typeof q.id !== 'string' || !q.id.trim())
    errors.push('id doit être une string non vide');
  if (typeof q.theme !== 'string' || !q.theme.trim() || q.theme.length > 60)
    errors.push('theme invalide');
  if (!['easy', 'medium', 'hard'].includes(q.difficulty))
    errors.push('difficulty doit être easy|medium|hard');
  if (typeof q.question !== 'string')
    errors.push('question doit être une string');
  else {
    const trimmed = q.question.trim();
    if (trimmed.length < 10 || trimmed.length > 240)
      errors.push('question longueur 10-240');
    if (!trimmed.endsWith('?'))
      errors.push('question doit finir par "?"');
  }

  // 3. Options
  if (!Array.isArray(q.options) || q.options.length !== 4)
    errors.push('options doit contenir exactement 4 entrées');
  else {
    const expectedKeys = ['A', 'B', 'C', 'D'];
    q.options.forEach((opt, i) => {
      if (!opt || typeof opt !== 'object') {
        errors.push(`option[${i}] invalide`);
        return;
      }
      if (opt.key !== expectedKeys[i])
        errors.push(`option[${i}].key doit être "${expectedKeys[i]}"`);
      if (typeof opt.text !== 'string') {
        errors.push(`option[${i}].text doit être string`);
      } else {
        const t = opt.text.trim();
        if (t.length < 1 || t.length > 120)
          errors.push(`option[${i}].text longueur 1-120`);
      }
    });
  }

  // 4. answer et funnyOption
  if (!['A', 'B', 'C', 'D'].includes(q.answer))
    errors.push('answer doit être A|B|C|D');
  if (!['A', 'B', 'C', 'D'].includes(q.funnyOption))
    errors.push('funnyOption doit être A|B|C|D');
  if (q.answer && q.funnyOption && q.answer === q.funnyOption)
    errors.push('funnyOption doit être différent de answer');

  // 5. explanation
  if (typeof q.explanation !== 'string') {
    errors.push('explanation doit être string');
  } else {
    const t = q.explanation.trim();
    if (t.length < 20 || t.length > 280)
      errors.push('explanation longueur 20-280');
  }

  // 6. Filtre humour grossier (liste noire minimale, extensible)
  const FORBIDDEN = [
    /\b(nazi|hitler|fascisme)\b/i,
    /\b(pute|bitte|cul|foutre|ntm)\b/i,
    /\b(raciste|racisme)\b/i,
    /\b(pédo|pedo)\b/i,
  ];
  const haystack = `${q.question} ${q.options.map(o => o.text).join(' ')} ${q.funnyOption ? '' : ''}`;
  const funnyText = (q.options.find(o => o.key === q.funnyOption)?.text) || '';
  const toCheck = `${q.question} ${q.options.map(o => o.text).join(' ')} ${funnyText}`;
  if (FORBIDDEN.some(re => re.test(toCheck)))
    errors.push('humour offensant détecté');

  if (errors.length) return { ok: false, errors };

  // 7. Normalisation : réordonne options (Fisher-Yates) et met à jour answer/funnyOption
  const keys = q.options.map(o => o.key); // ["A","B","C","D"]
  const reordered = fisherYatesShallow(keys, rng); // permutation de keys
  const remap = Object.fromEntries(reordered.map((k, i) => [k, ['A','B','C','D'][i]]));
  const newOptions = reordered.map((k, i) => ({
    key: ['A', 'B', 'C', 'D'][i],
    text: q.options.find(o => o.key === k).text,
  }));
  const newAnswer = remap[q.answer];
  const newFunny = remap[q.funnyOption];

  return {
    ok: true,
    errors: [],
    normalized: {
      id: q.id,
      theme: q.theme,
      difficulty: q.difficulty,
      question: q.question.trim(),
      options: newOptions,
      answer: newAnswer,
      funnyOption: newFunny,
      explanation: q.explanation.trim(),
    },
  };
}
```

### 6.5. Pseudo-code `parseQuestions(rawJson)`

```javascript
/**
 * rawJson : ce qu'on a extrait de la réponse LLM (string ou objet).
 * Retourne { questions: Question[], errors: string[] }
 */
function parseQuestions(rawJson) {
  let parsed;
  if (typeof rawJson === 'string') {
    try { parsed = JSON.parse(rawJson); }
    catch { return { questions: [], errors: ['JSON global invalide'] }; }
  } else if (typeof rawJson === 'object' && rawJson !== null) {
    parsed = rawJson;
  } else {
    return { questions: [], errors: ['type racine invalide'] };
  }

  // Tolérance : accepte soit { questions: [...] }, soit [...] directement
  const arr = Array.isArray(parsed) ? parsed
            : Array.isArray(parsed.questions) ? parsed.questions
            : null;
  if (!arr) return { questions: [], errors: ['tableau de questions introuvable'] };

  const out = [];
  const errors = [];
  arr.forEach((q, i) => {
    const r = validateQuestion(q, i);
    if (r.ok) out.push(r.normalized);
    else errors.push(`q[${i}]: ${r.errors.join(', ')}`);
  });

  return { questions: out, errors };
}
```

---

## 7. Module `api.js`

### 7.1. Signature publique

```javascript
/**
 * Demande un lot de questions au LLM via le proxy /api.
 *
 * @param {Object} params
 * @param {string} params.theme           Thème des questions (libre ou prédéfini)
 * @param {number} params.batchSize       Nombre de questions à demander (1-20)
 * @param {string[]} [params.exclude]     Questions déjà posées (anti-doublon)
 * @returns {Promise<{
 *   questions: import('./validation').Question[],
 *   errors: string[],
 *   raw?: any   // réponse brute pour debug si configuré
 * }>}
 *
 * @throws {ApiError} en cas d'échec définitif après retries.
 *   Codes : TIMEOUT, NETWORK, INVALID_JSON, INCOMPLETE_BATCH, UPSTREAM_4XX, UPSTREAM_5XX
 */
export async function fetchQuestionBatch({ theme, batchSize, exclude = [] }) { /* ... */ }

/**
 * Codes d'erreur normalisés pour la couche UI.
 */
export class ApiError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'ApiError';
    this.code = code;   // 'TIMEOUT' | 'NETWORK' | 'INVALID_JSON' | 'INCOMPLETE_BATCH'
                        // | 'UPSTREAM_4XX' | 'UPSTREAM_5XX' | 'AUTH'
    this.cause = cause;
  }
}
```

### 7.2. Payload exact envoyé à `/api/chat/completions`

Le navigateur envoie au proxy (et le proxy forwarde tel quel, en ajoutant `Authorization`) :

```json
{
  "model": "<LLM_MODEL>",
  "temperature": 0.9,
  "response_format": { "type": "json_object" },
  "max_tokens": 2048,
  "messages": [
    {
      "role": "system",
      "content": "<prompt système construit par prompt.js>"
    },
    {
      "role": "user",
      "content": "<prompt utilisateur construit par prompt.js>"
    }
  ]
}
```

| Champ | Source | Notes |
|-------|--------|-------|
| `model` | `env.LLM_MODEL` | Lu côté serveur ; **pas** envoyé par le navigateur |
| `temperature` | `env.LLM_TEMPERATURE` | Idem |
| `response_format` | hardcoded | Force JSON (compatible Mammouth, OpenAI, OpenRouter, Groq, Ollama ≥ 0.5) |
| `max_tokens` | hardcoded `2048` | Suffisant pour ~5 questions courtes |
| `messages` | construit par `prompt.js` | 2 messages : system + user |

> Note : le navigateur **ne connaît pas** `model` ni `temperature`. Ces valeurs sont ajoutées par le proxy, ou bien le navigateur les lit depuis `/api/health` au boot (mais cela reste optionnel). En pratique, **le navigateur envoie déjà `model` et `temperature` dans le body** pour rester simple ; le proxy peut alors override avec `.env` si besoin. Choix retenu ici : **le navigateur envoie tout**, le proxy ne touche qu'aux headers. Cela simplifie l'implémentation et reste sûr puisque `.env` n'est pas dans le bundle.

### 7.3. Parsing défensif

```javascript
/**
 * Extrait un objet JSON d'une chaîne qui peut contenir :
 *   - du texte avant/après
 *   - des fences markdown ```json ... ```
 *   - des commentaires // ou /* ... *\/
 *   - des virgules trailing
 *
 * Retourne { json, method } ou { error }.
 */
function extractJson(raw) {
  if (typeof raw !== 'string') return { error: 'not a string' };
  let s = raw.trim();

  // 1. Fences markdown ```json ... ``` ou ``` ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) s = fence[1].trim();

  // 2. Si la chaîne commence/fin par des backticks simples, on nettoie
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
    try { return { json: JSON.parse(candidate), method: 'parse' }; }
    catch { /* continue */ }
  }
  return { error: 'all parse attempts failed' };
}

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
function stripTrailingCommas(s) {
  return s.replace(/,(\s*[\]}])/g, '$1');
}
```

### 7.4. Politique de retries et backoff

| Situation | Comportement |
|-----------|--------------|
| JSON invalide côté LLM (extract échoue, ou `parseQuestions` rejette tout) | **2 retries silencieux** (re-appel LLM avec même prompt) ; si toujours KO, `ApiError('INVALID_JSON')` |
| HTTP 429 (rate limit) | Backoff exponentiel : **2 s → 4 s → 8 s**. 3 tentatives max. Au-delà : `ApiError('UPSTREAM_4XX', '429')`. Le navigateur affiche un toast « Trop de requêtes, réessayez dans quelques secondes ». |
| HTTP 401/403 | `ApiError('AUTH')` immédiat, pas de retry (clé invalide). |
| HTTP 5xx | 1 retry après 2 s ; au-delà : `ApiError('UPSTREAM_5XX')`. |
| Timeout (30 s client) | `ApiError('TIMEOUT')`, pas de retry. |
| Network error (`fetch` reject) | 1 retry après 1 s ; au-delà : `ApiError('NETWORK')`. |
| Batch incomplet (LLM renvoie < `batchSize` valides) | **Pas d'erreur** : on retourne ce qui a passé validation. La phase de préchargement (§ 11) déclenchera un nouveau lot. Si 0 question valide → `ApiError('INCOMPLETE_BATCH')` (rare). |

### 7.5. Timeout via `AbortController`

```javascript
async function fetchWithTimeout(url, options, timeoutMs = 30_000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
```

### 7.6. Implémentation de référence de `fetchQuestionBatch`

```javascript
export async function fetchQuestionBatch({ theme, batchSize, exclude = [] }) {
  const settings = getSettings(); // depuis state.js
  const history = exclude;
  const systemPrompt = buildSystemPrompt({
    theme, batchSize, history,
    schemaJSON: QUESTION_SCHEMA_JSON,
  });
  const userPrompt = buildUserPrompt({ theme, batchSize, history });

  const body = {
    model: settings.model,
    temperature: settings.temperature,
    response_format: { type: 'json_object' },
    max_tokens: 2048,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };

  // --- Stratégie de retries imbriquée ---
  const MAX_INVALID_JSON = 2;   // 2 retries silencieux
  let invalidJsonTries = 0;
  let lastError = null;

  while (invalidJsonTries <= MAX_INVALID_JSON) {
    try {
      const res = await fetchWithTimeout('/api/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 30_000);

      // Gestion par code HTTP avec backoff
      if (res.status === 429) {
        await backoffWithAbort([2000, 4000, 8000]);
        continue; // relance (considéré comme un retry 'upstream_4xx')
      }
      if (res.status === 401 || res.status === 403) {
        throw new ApiError('AUTH', `Authentification refusée (HTTP ${res.status}). Vérifiez LLM_API_KEY dans .env.`);
      }
      if (res.status >= 500) {
        if (invalidJsonTries < MAX_INVALID_JSON) {
          invalidJsonTries++;
          await sleep(2000);
          continue;
        }
        throw new ApiError('UPSTREAM_5XX', `Provider indisponible (HTTP ${res.status}).`);
      }
      if (!res.ok) {
        throw new ApiError('UPSTREAM_4XX', `Réponse inattendue (HTTP ${res.status}).`);
      }

      // --- Lecture du JSON upstream ---
      const text = await res.text();
      const envelope = JSON.parse(text); // la réponse elle-même est du JSON
      const assistant = envelope?.choices?.[0]?.message?.content;
      if (typeof assistant !== 'string' || !assistant.trim()) {
        throw new ApiError('INVALID_JSON', 'Réponse LLM vide.');
      }

      // --- Extraction défensive ---
      const extracted = extractJson(assistant);
      if (extracted.error) {
        invalidJsonTries++;
        lastError = new ApiError('INVALID_JSON', extracted.error);
        if (invalidJsonTries > MAX_INVALID_JSON) throw lastError;
        continue; // retry silencieux
      }

      // --- Validation contrat ---
      const parsed = parseQuestions(extracted.json);
      if (!parsed.questions.length) {
        invalidJsonTries++;
        lastError = new ApiError('INVALID_JSON',
          `0 question valide. Erreurs: ${parsed.errors.join(' | ')}`);
        if (invalidJsonTries > MAX_INVALID_JSON) throw lastError;
        continue;
      }

      // --- Anti-doublon côté client ---
      const seen = new Set(exclude.map(normalizeQuestionText));
      const unique = parsed.questions.filter(q =>
        !seen.has(normalizeQuestionText(q.question))
      );

      if (unique.length === 0 && parsed.errors.length) {
        // toutes des doublons : on signale mais on retourne ce qu'on a
        return {
          questions: parsed.questions, // on garde pour ne pas boucler
          errors: parsed.errors,
          raw: extracted.json,
        };
      }

      return {
        questions: unique.length ? unique : parsed.questions,
        errors: parsed.errors,
        raw: undefined,
      };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err.name === 'AbortError') {
        throw new ApiError('TIMEOUT', 'La requête a dépassé 30 s.');
      }
      // Erreur réseau : 1 retry
      if (invalidJsonTries < MAX_INVALID_JSON) {
        invalidJsonTries++;
        await sleep(1000);
        continue;
      }
      throw new ApiError('NETWORK', err.message || 'Erreur réseau inconnue', err);
    }
  }
  throw lastError ?? new ApiError('NETWORK', 'Échec inconnu après retries.');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
function normalizeQuestionText(s) {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').trim();
}
```

### 7.7. Schéma JSON inliné dans le prompt

```javascript
export const QUESTION_SCHEMA_JSON = JSON.stringify({
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id','theme','difficulty','question','options','answer','funnyOption','explanation'],
        properties: {
          id: { type: 'string' },
          theme: { type: 'string' },
          difficulty: { enum: ['easy','medium','hard'] },
          question: { type: 'string' },
          options: {
            type: 'array', minItems: 4, maxItems: 4,
            items: {
              type: 'object',
              required: ['key','text'],
              properties: {
                key: { enum: ['A','B','C','D'] },
                text: { type: 'string' }
              }
            }
          },
          answer: { enum: ['A','B','C','D'] },
          funnyOption: { enum: ['A','B','C','D'] },
          explanation: { type: 'string' }
        }
      }
    }
  },
  required: ['questions']
}, null, 2);
```

---

## 8. Module `prompt.js`

### 8.1. Objectif

Produire deux messages (`system` et `user`) qui forcent le LLM à générer un lot de questions respectant le contrat de la § 6.

### 8.2. Prompt système (mot pour mot, en français)

```text
Tu es un générateur de quiz pour un jeu familial multijoueur appelé "Quizz Canapé".
Tu dois produire UNIQUEMENT du JSON valide conforme au schéma fourni.

RÈGLES ABSOLUES (NON NÉGOCIABLES) :
1. Tu réponds TOUJOURS en JSON strict, sans texte autour, sans markdown, sans commentaire.
2. Le JSON racine a la forme { "questions": [ ... ] } avec EXACTEMENT {batchSize} questions.
3. Chaque question possède OBLIGATOIREMENT les champs :
   id, theme, difficulty, question, options, answer, funnyOption, explanation.
4. options est un tableau de LONGUEUR EXACTEMENT 4, avec clés "A", "B", "C", "D" dans cet ordre.
5. answer ∈ {"A","B","C","D"} et funnyOption ∈ {"A","B","C","D"} avec funnyOption != answer.
6. La "funnyOption" est volontairement drôle, absurde ou farfelue — JAMAIS la bonne réponse.
7. difficulty ∈ {"easy", "medium", "hard"} — répartis équitablement dans le lot.
8. explanation : 1 à 3 phrases courtes (20 à 280 caractères), factuelle et instructive.
9. Tu ne poses JAMAIS deux fois la même question (cf. {historiqueDesQuestions}).
10. Les questions sont sur le thème : "{theme}".
11. Tu évites toute question ambiguë : la bonne réponse doit être défendable et défendable uniquement.
12. Tu n'inclus AUCUN contenu offensant, discriminatoire, politique, religieux, sexuellement explicite ou vulgaire — y compris dans les funnyOptions.
13. Le contenu est adapté à un public familial (tous âges), en français standard.
14. Tu fais preuve de créativité, d'humour léger, et de variété (pas de questions recyclées).

STYLE DES FUNNY OPTIONS :
- L'option drôle doit être reconnaissable comme comique mais pas grotesque.
- Elle est plausible à première vue mais absurde après réflexion.
- Privilégie l'humour de situation, le calembour, le détournement, le nonsens poétique.
- Elle ne doit jamais être la bonne réponse même en cas de doute.

MÉTA :
- id : chaîne unique, format recommandé "q_<timestamp>_<index>".
- theme : répète exactement le thème demandé.
- difficulty : "easy" = culture générale large ; "medium" = niche connue ; "hard" = expertise.

SCHÉMA DE RÉPONSE (à respecter STRICTEMENT) :
{schemaJSON}

FORMAT DE SORTIE :
- Commence directement par {.
- Termine par }.
- Aucun caractère en dehors du JSON.
```

### 8.3. Prompt utilisateur (mot pour mot)

```text
Génère maintenant un lot de {batchSize} question(s) sur le thème "{theme}".

Rappel des questions déjà posées dans cette session (NE PAS RÉPÉTER) :
{historiqueDesQuestions}

Réponds UNIQUEMENT avec le JSON :
{{ "questions": [ ... {batchSize} entrées ... ] }}
```

### 8.4. Implémentation `prompt.js`

```javascript
import { QUESTION_SCHEMA_JSON } from './api.js'; // ou depuis constants.js

export function buildSystemPrompt({ theme, batchSize, history = [], schemaJSON }) {
  const historique = history.length
    ? history.map((q, i) => `${i + 1}. ${q}`).join('\n')
    : '(aucune question posée pour le moment)';

  return `Tu es un générateur de quiz pour un jeu familial multijoueur appelé "Quizz Canapé".
Tu dois produire UNIQUEMENT du JSON valide conforme au schéma fourni.

RÈGLES ABSOLUES (NON NÉGOCIABLES) :
1. Tu réponds TOUJOURS en JSON strict, sans texte autour, sans markdown, sans commentaire.
2. Le JSON racine a la forme { "questions": [ ... ] } avec EXACTEMENT ${batchSize} question(s).
3. Chaque question possède OBLIGATOIREMENT les champs :
   id, theme, difficulty, question, options, answer, funnyOption, explanation.
4. options est un tableau de LONGUEUR EXACTEMENT 4, avec clés "A", "B", "C", "D" dans cet ordre.
5. answer ∈ {"A","B","C","D"} et funnyOption ∈ {"A","B","C","D"} avec funnyOption != answer.
6. La "funnyOption" est volontairement drôle, absurde ou farfelue — JAMAIS la bonne réponse.
7. difficulty ∈ {"easy", "medium", "hard"} — répartis équitablement dans le lot.
8. explanation : 1 à 3 phrases courtes (20 à 280 caractères), factuelle et instructive.
9. Tu ne poses JAMAIS deux fois la même question (cf. historique ci-dessous).
10. Les questions sont sur le thème : "${theme}".
11. Tu évites toute question ambiguë : la bonne réponse doit être défendable et défendable uniquement.
12. Tu n'inclus AUCUN contenu offensant, discriminatoire, politique, religieux, sexuellement explicite ou vulgaire — y compris dans les funnyOptions.
13. Le contenu est adapté à un public familial (tous âges), en français standard.
14. Tu fais preuve de créativité, d'humour léger, et de variété (pas de questions recyclées).

STYLE DES FUNNY OPTIONS :
- L'option drôle doit être reconnaissable comme comique mais pas grotesque.
- Elle est plausible à première vue mais absurde après réflexion.
- Privilégie l'humour de situation, le calembour, le détournement, le nonsens poétique.
- Elle ne doit jamais être la bonne réponse même en cas de doute.

MÉTA :
- id : chaîne unique, format recommandé "q_<timestamp>_<index>".
- theme : répète exactement le thème demandé.
- difficulty : "easy" = culture générale large ; "medium" = niche connue ; "hard" = expertise.

SCHÉMA DE RÉPONSE (à respecter STRICTEMENT) :
${schemaJSON}

FORMAT DE SORTIE :
- Commence directement par {.
- Termine par }.
- Aucun caractère en dehors du JSON.

HISTORIQUE DES QUESTIONS DÉJÀ POSÉES (à NE PAS RÉPÉTER) :
${historique}`;
}

export function buildUserPrompt({ theme, batchSize, history = [] }) {
  const historique = history.length
    ? history.map((q, i) => `${i + 1}. ${q}`).join('\n')
    : '(aucune)';

  return `Génère maintenant un lot de ${batchSize} question(s) sur le thème "${theme}".

Rappel des questions déjà posées dans cette session (NE PAS RÉPÉTER) :
${historique}

Réponds UNIQUEMENT avec le JSON :
{ "questions": [ ... ${batchSize} entrée(s) ... ] }`;
}
```

### 8.5. Interdits côté prompt

Le prompt système interdit explicitement :

- Reprise d'une question déjà dans `historiqueDesQuestions`.
- Questions ambiguës (plusieurs réponses défendables).
- Humour offensant, discriminatoire, politique, religieux, sexuellement explicite, vulgaire.
- Sortie non-JSON.

---

## 9. Module `state.js`

### 9.1. Forme exacte de `state`

```javascript
/**
 * État global unique de l'application.
 * Immutable côté consommateurs : seul `dispatch(action)` peut le modifier.
 */
const INITIAL_STATE = Object.freeze({
  // === Joueurs ===
  players: [
    // { id: 'p1', name: 'Alice', emoji: '🦊', color: '#a855f7', score: 0 }
  ],

  // === Paramètres (modifiables à SETUP, snapshotés au début de partie) ===
  // Les onze premiers champs sont les `MODE_RULE_KEYS` : ce sont eux, et eux
  // seuls, qu'un mode de jeu pilote.
  settings: {
    targetScore: 15, twoPointLead: false, bonusEnabled: false,
    difficulty: 'balanced', audience: 'general',
    timerEnabled: true, timePerQuestion: 60,
    penaltyNoAnswer: false, penaltyWrongAnswer: true,
    punisherSeverity: 'punitive', manchesTarget: 1,

    theme: 'Culture générale', // sujet du quiz, prédéfini ou libre
    modeId: 'epice',           // mode d'origine des règles ci-dessus
    sourceMode: 'theme',       // 'theme' | 'wikipedia'
    sourceTitle: '', sourceLang: 'fr', sourceUrl: '',
  },

  // === Configuration LLM ===
  // Délibérément HORS de `settings` : celui-ci est recopié en entier dans chaque
  // partie archivée et chaque instantané de reprise. La clé API s'y retrouvait
  // dupliquée à chaque sauvegarde. Elle est aussi globale à l'appareil.
  llm: { model: '', baseUrl: '', apiKey: '', temperature: 0.9, batchSize: 5 },

  // === Hiérarchie de jeu (non spécifiée dans ce document — voir AGENTS.md) ===
  session: null, // roster + sac de parties, aucune condition de fin
  partie: null,  // best-of de manches

  // === Source Wikipédia ===
  // Hors de `settings` : celui-ci est réécrit dans localStorage à chaque
  // dispatch, et l'article pèse plusieurs kilo-octets.
  source: null,

  // === Questions ===
  questions: [],               // Question[] déjà validées
  currentIndex: -1,            // index dans `questions` (-1 = aucune affichée)

  // === Saisie MJ sur la question courante ===
  roundAnswers: {
    // [playerId]: 'A' | 'B' | 'C' | 'D' | null
  },
  isBonusRound: false,         // la question courante est-elle une question bonus ?

  // === Phase courante ===
  phase: 'HOME',
  // 'HOME' | 'SETUP' | 'LOADING' | 'QUESTION' | 'REVEAL' | 'MANCHE_END'
  // | 'VICTORY' | 'SESSIONS' | 'SETTINGS'
  //
  // Toute nouvelle phase doit être ajoutée À LA FOIS dans `MOUNTERS` et
  // `UNMOUNTERS` de `main.js`, sinon l'écran reste blanc sans erreur.

  // === File de préchargement ===
  prefetchQueue: [],           // Question[] déjà reçues, en attente d'affichage
  prefetchInflight: false,     // un fetch LLM est en cours

  // === Historique anti-doublon (énoncés normalisés) ===
  history: [],                 // string[] (énoncés normalisés de toutes les questions posées)

  // === Statistiques persistantes ===
  stats: {
    gamesPlayed: 0,
    questionsAnswered: 0,
    correctAnswers: 0,
    perPlayer: {
      // [playerId]: { name, emoji, gamesPlayed, wins, totalScore }
    },
  },

  // === UI transient ===
  ui: {
    lastError: null,           // { code, message, ts } | null
    isOnline: navigator.onLine,
    isFetching: false,
    // Transients : la source de vérité reste IndexedDB, ceci n'en est que
    // la copie affichable. Vidés par un reset, jamais persistés tels quels.
    resumables: [],            // parties interrompues de la session courante
    modes: [],                 // catalogue des modes de jeu
  },
});
```

### 9.2. Machine à états — diagramme

```
        ┌──────┐  start()       ┌─────────┐  batchReady  ┌──────────┐
        │SETUP ├───────────────►│LOADING  ├─────────────►│ QUESTION │
        └──┬───┘                └────┬────┘              └────┬─────┘
           ▲                         │ timeout/error           │ allPlayersAnswered()
           │ newGame()               ▼                         ▼
           │                     (retour SETUP)           ┌────────┐
           │                                              │ REVEAL │
           │                                              └───┬────┘
           │                                                  │ nextQuestion()
           │                                                  │  ┌─ si questions restantes ─► QUESTION
           │                                                  │  └─ si score atteint        ─► VICTORY
           │                                                  ▼
           │                                              ┌─────────┐
           └──────────────────────────────────────────────│ VICTORY │
                                                         └─────────┘
```

### 9.3. Liste exhaustive des actions / reducers

| Action | Payload | Effet sur `state` |
|--------|---------|-------------------|
| `SET_PLAYERS` | `players[]` | Remplace `state.players`, reset scores à 0 |
| `UPDATE_PLAYER` | `{ id, patch }` | Patch partiel sur un joueur |
| `REMOVE_PLAYER` | `id` | Retire le joueur de `players` |
| `SET_SETTINGS` | `Partial<settings>` | Merge dans `state.settings` |
| `START_GAME` | — | Snapshot `settings`, `phase='LOADING'`, `currentIndex=-1`, `questions=[]`, `history` conservé ou reset selon option |
| `BATCH_RECEIVED` | `Question[]` | Push dans `prefetchQueue` ou `questions` selon phase |
| `SHOW_NEXT_QUESTION` | — | `phase='QUESTION'`, déplace 1 question de `prefetchQueue` vers `questions`, incrémente `currentIndex`, reset `roundAnswers`, choisit aléatoirement `isBonusRound` si bonus activé |
| `PLAYER_ANSWER` | `{ playerId, optionKey }` | Set `roundAnswers[playerId]` |
| `CLEAR_PLAYER_ANSWER` | `playerId` | Supprime l'entrée `roundAnswers[playerId]` |
| `REVEAL_ANSWER` | — | `phase='REVEAL'`, calcule gagnants, met à jour `players[].score`, met à jour `stats` |
| `GOTO_VICTORY` | — | `phase='VICTORY'`, incrémente `stats.gamesPlayed` |
| `NEW_GAME` | — | `phase='SETUP'`, conserve `players` et `stats`, reset scores et questions |
| `RESET_ALL` | — | Réinitialise tout (Clear `localStorage`) |
| `SET_ERROR` | `{ code, message }` | Set `ui.lastError` |
| `CLEAR_ERROR` | — | `ui.lastError = null` |
| `SET_FETCHING` | `boolean` | `ui.isFetching` |
| `SET_ONLINE` | `boolean` | `ui.isOnline` |

### 9.4. Pattern pub/sub

```javascript
const state = { ...INITIAL_STATE };
const subscribers = new Set();

export function getState() {
  // Retour superficiel — les consumers doivent traiter comme read-only.
  return state;
}

export function subscribe(fn) {
  subscribers.add(fn);
  // Envoie l'état courant immédiatement
  try { fn(state); } catch (e) { console.error('[state] subscriber error', e); }
  return () => subscribers.delete(fn);
}

function notify() {
  for (const fn of subscribers) {
    try { fn(state); }
    catch (e) { console.error('[state] subscriber error', e); }
  }
}

export function dispatch(action) {
  reducer(state, action);
  notify();
}

function reducer(s, action) {
  switch (action.type) {
    case 'SET_PLAYERS':
      s.players = action.players.map(p => ({ ...p, score: 0 }));
      break;

    case 'UPDATE_PLAYER': {
      const idx = s.players.findIndex(p => p.id === action.id);
      if (idx >= 0) s.players[idx] = { ...s.players[idx], ...action.patch };
      break;
    }

    case 'REMOVE_PLAYER':
      s.players = s.players.filter(p => p.id !== action.id);
      break;

    case 'SET_SETTINGS':
      s.settings = { ...s.settings, ...action.patch };
      break;

    case 'START_GAME':
      s.settings = { ...s.settings }; // snapshot
      s.questions = [];
      s.prefetchQueue = [];
      s.prefetchInflight = false;
      s.currentIndex = -1;
      s.roundAnswers = {};
      s.isBonusRound = false;
      s.phase = 'LOADING';
      s.history = action.resetHistory ? [] : s.history;
      // Lance le premier fetch
      triggerInitialBatch();
      break;

    case 'BATCH_RECEIVED':
      // Toujours empiler : le premier lot et les lots suivants suivent le même modèle.
      // Le contrôleur asynchrone dispatchera SHOW_NEXT_QUESTION après le premier lot.
      s.prefetchQueue.push(...action.questions);
      s.prefetchInflight = false;
      if (s.phase === 'LOADING' && s.prefetchQueue.length > 0) {
        s.phase = 'QUESTION';
        s.currentIndex = -1;
      }
      break;

    case 'SHOW_NEXT_QUESTION':
      if (s.prefetchQueue.length === 0) {
        // Pas de question en stock : on reste en QUESTION et on attend
        // (ne devrait pas arriver grâce au préchargement § 11)
        return;
      }
      const next = s.prefetchQueue.shift();
      s.questions.push(next);
      s.currentIndex = s.questions.length - 1;
      s.history.push(normalizeQuestionText(next.question));
      s.roundAnswers = Object.fromEntries(s.players.map(p => [p.id, null]));
      s.isBonusRound = s.settings.bonusEnabled && Math.random() < 0.15; // ~15% de chance
      s.phase = 'QUESTION';
      // Déclenche le préchargement du lot suivant
      maybePrefetchNext();
      break;

    case 'PLAYER_ANSWER':
      s.roundAnswers[action.playerId] = action.optionKey;
      break;

    case 'CLEAR_PLAYER_ANSWER':
      delete s.roundAnswers[action.playerId];
      break;

    case 'REVEAL_ANSWER': {
      s.phase = 'REVEAL';
      const q = s.questions[s.currentIndex];
      const correctKey = q.answer;
      const bonusMult = s.isBonusRound ? 2 : 1;
      let correctCount = 0;
      for (const p of s.players) {
        const ans = s.roundAnswers[p.id];
        if (ans === correctKey) {
          p.score += bonusMult;
          correctCount++;
          s.stats.perPlayer[p.id] = s.stats.perPlayer[p.id] || initPerPlayer(p);
          s.stats.perPlayer[p.id].totalScore += bonusMult;
        }
      }
      s.stats.questionsAnswered += s.players.length;
      s.stats.correctAnswers += correctCount;
      break;
    }

    case 'GOTO_VICTORY':
      s.phase = 'VICTORY';
      // Le vainqueur est déterminé côté UI (scores + règle 2 pts d'écart)
      const winner = computeWinner(s);
      if (winner) {
        s.stats.perPlayer[winner.id] = s.stats.perPlayer[winner.id] || initPerPlayer(winner);
        s.stats.perPlayer[winner.id].wins += 1;
      }
      s.stats.gamesPlayed += 1;
      saveStats(s.stats);
      break;

    case 'NEW_GAME':
      s.players = s.players.map(p => ({ ...p, score: 0 }));
      s.questions = [];
      s.prefetchQueue = [];
      s.prefetchInflight = false;
      s.currentIndex = -1;
      s.roundAnswers = {};
      s.phase = 'SETUP';
      break;

    case 'RESET_ALL':
      Object.assign(s, INITIAL_STATE, { stats: { gamesPlayed: 0, questionsAnswered: 0, correctAnswers: 0, perPlayer: {} } });
      clearAll();
      break;

    case 'SET_ERROR':
      s.ui.lastError = { ...action.error, ts: Date.now() };
      break;

    case 'CLEAR_ERROR':
      s.ui.lastError = null;
      break;

    case 'SET_FETCHING':
      s.ui.isFetching = action.value;
      break;

    case 'SET_ONLINE':
      s.ui.isOnline = action.value;
      break;

    default:
      console.warn('[state] action inconnue', action.type);
  }
}

// Helpers exportés
function normalizeQuestionText(s) { /* idem api.js */ }
function computeWinner(s) { /* voir § 10 */ }
function initPerPlayer(p) { return { name: p.name, emoji: p.emoji, gamesPlayed: 0, wins: 0, totalScore: 0 }; }
```

### 9.5. Hydratation depuis `localStorage`

Au démarrage (`main.js`) :

```javascript
import { loadPlayers, loadSettings, loadStats } from './storage.js';
import { dispatch, getState, subscribe } from './state.js';

// Hydratation
const persistedPlayers = loadPlayers();
const persistedSettings = loadSettings();
const persistedStats = loadStats();
if (persistedPlayers) dispatch({ type: 'SET_PLAYERS', players: persistedPlayers });
if (persistedSettings) dispatch({ type: 'SET_SETTINGS', patch: persistedSettings });
// stats : lecture seule (state.stats = persistedStats à l'init, puis mis à jour par dispatch)

// Persistance automatique (subscribe)
subscribe(state => {
  savePlayers(state.players);
  saveSettings(state.settings);
});
```

---

## 10. Logique de scoring

### 10.1. Règles

| Règle | Valeur |
|-------|--------|
| Bonne réponse | **+1 point** pour le joueur |
| Mauvaise réponse | **0 point** |
| Pas de réponse | **0 point** (le MJ peut laisser un joueur blanc) |
| Question bonus (si activée) | bonne réponse = **×2** donc **+2 points** |
| Score cible (défaut) | **15** |
| Score cible (plage UI) | **5 à 30** (slider entier) |

### 10.2. Condition de victoire — version simple

> Un joueur gagne la partie **dès que son score atteint `targetScore`** ET, si l'option « 2 points d'écart »
Lorsque plusieurs joueurs atteignent la cible à la même révélation, le score le plus élevé gagne. En cas d'égalité exacte, le premier joueur dans l'ordre `players[]` gagne ; afficher « égalité départagée par l'ordre de saisie ».

### 10.3. Condition de victoire — option « 2 points d'écart »

Après chaque `REVEAL_ANSWER`, calculer :

```javascript
function hasVictory(state) {
  const target = state.settings.targetScore;
  const ranked = [...state.players].sort((a, b) => b.score - a.score);
  const leader = ranked[0];
  const second = ranked[1];
  if (!leader || leader.score < target) return false;
  if (!state.settings.twoPointLead) return true;
  return !second || leader.score - second.score >= 2;
}
```

- Ne jamais terminer la manche avant la révélation : le point est toujours visible.
- Si la cible est atteinte mais l'écart est insuffisant, rester en `REVEAL`, afficher « Encore X point(s) d'écart requis », puis proposer `QUESTION SUIVANTE`.
- Le bouton `QUESTION SUIVANTE` devient `VOIR LE PODIUM` uniquement quand `hasVictory(state)` est vrai.
- Le seuil est évalué après application du multiplicateur bonus.
- Un joueur peut dépasser la cible : son score n'est jamais plafonné.

### 10.4. Détermination d'un gagnant

```javascript
function computeWinner(state) {
  const ranked = [...state.players].sort((a, b) => {
    const scoreDelta = b.score - a.score;
    if (scoreDelta !== 0) return scoreDelta;
    return state.players.indexOf(a) - state.players.indexOf(b);
  });
  return hasVictory(state) ? ranked[0] : null;
}
```

### 10.5. Question bonus

- Si `bonusEnabled=false`, `isBonusRound` est toujours `false`.
- Si `bonusEnabled=true`, une question sur 5 est bonus (déterminer au tirage, pas au rendu).
- Marquer la carte avec `data-bonus="true"`, une pastille `×2 BONUS`, et une animation lime.
- Le bonus s'applique à tous les joueurs répondant correctement à cette question.

---

## 11. Préchargement des questions

### 11.1. Objectif et invariants

Le système doit générer **5 questions au démarrage** (ou `settings.batchSize` si l'environnement est configuré autrement), commencer à afficher la première dès réception, puis garantir qu'aucun nouvel appel LLM n'est nécessaire pendant l'affichage de la question 2, 3, 4 ou 5.

Invariants à respecter :

1. À `START_GAME`, lancer exactement un appel initial avec `batchSize = 5`.
2. Ne jamais afficher une question non validée.
3. `history` contient toute question affichée dans la session, pas seulement la file.
4. Ne jamais lancer deux lots simultanément (`prefetchInflight` est un verrou).
5. Déclencher le lot suivant dès l'affichage de la **question 3**, sans attendre la révélation.
6. Un lot suivant est demandé avec `exclude = history` et ajouté à `prefetchQueue`.
7. Si le lot renvoie moins de questions valides, lancer un complément tant qu'il existe un besoin et que le provider répond.
8. Si un appel échoue après la première question, conserver les questions déjà en file et afficher un bouton « Réessayer la génération » ; ne pas perdre la partie.

### 11.2. Modèle de file

```javascript
// Au démarrage
state.prefetchQueue = [];       // questions non affichées
state.questions = [];            // questions effectivement affichées
state.currentIndex = -1;

async function loadInitialBatch() {
  dispatch({ type: 'SET_FETCHING', value: true });
  try {
    const result = await fetchQuestionBatch({
      theme: getState().settings.theme,
      batchSize: 5,
      exclude: [],
    });
    dispatch({ type: 'BATCH_RECEIVED', questions: result.questions });
    // Le reducer met le lot en file ; afficher ensuite la première question.
    if (getState().prefetchQueue.length > 0) {
      dispatch({ type: 'SHOW_NEXT_QUESTION' });
    }
  } catch (error) {
    dispatch({ type: 'SET_ERROR', error: toUiError(error) });
    dispatch({ type: 'NEW_GAME' });
  } finally {
    dispatch({ type: 'SET_FETCHING', value: false });
  }
}

function showNextQuestion() {
  if (getState().prefetchQueue.length === 0) {
    dispatch({ type: 'SET_ERROR', error: {
      code: 'EMPTY_QUEUE', message: 'Génération en cours : réessayez dans un instant.'
    }});
    return;
  }
  dispatch({ type: 'SHOW_NEXT_QUESTION' });
}

function maybePrefetchNext() {
  const s = getState();
  const displayedNumber = s.questions.length;
  const queueSize = s.prefetchQueue.length;
  if (s.prefetchInflight || displayedNumber < 3 || queueSize > 2) return;
  dispatch({ type: 'SET_PREFETCH_INFLIGHT', value: true });
  fetchQuestionBatch({
    theme: s.settings.theme,
    batchSize: 5,
    exclude: s.history,
  }).then(({ questions }) => {
    dispatch({ type: 'BATCH_RECEIVED', questions });
  }).catch(error => {
    dispatch({ type: 'SET_ERROR', error: toUiError(error) });
    dispatch({ type: 'SET_PREFETCH_INFLIGHT', value: false });
  });
}
```

`BATCH_RECEIVED` doit concaténer le lot à `prefetchQueue` lorsque le jeu est déjà en cours. Il ne doit pas écraser une file existante. Le premier lot est une exception : il est placé dans la file, puis `SHOW_NEXT_QUESTION` est dispatché.

### 11.3. Déclenchement précis

- « Question 1 » = première question affichée, même si `currentIndex` vaut 0.
- À `SHOW_NEXT_QUESTION`, après le rendu, appeler `maybePrefetchNext()` si `questions.length === 3` ou si la file est sous le seuil de 3.
- Autoriser le préfetch en arrière-plan pendant `QUESTION` et `REVEAL`, mais ne pas bloquer la saisie.
- Le batch suivant ne doit pas être généré à chaque render : utiliser `prefetchInflight` et un seuil de file.
- Reset de la file et de l'historique au lancement d'une nouvelle partie ; conserver l'historique dans une même partie après chaque lot.

### 11.4. Anti-doublon

Normaliser un énoncé par minuscules, espaces compressés, ponctuation supprimée et Unicode normalisé `NFD` puis accents supprimés. Rejeter une question dont la forme normalisée est déjà dans `history` ou apparaît deux fois dans le lot courant. En cas de collision d'`id`, remplacer l'id par `q_${Date.now()}_${crypto.randomUUID()}` côté client.

---

## 12. Écrans

### 12.1. Contrat de rendu commun

`main.js` possède un élément `<main id="app" aria-live="polite"></main>`. À chaque changement de `phase`, démonter le screen précédent, vider `#app`, puis appeler le renderer correspondant. Ne pas recréer les listeners globaux à chaque render. Les notifications non bloquantes sont rendues dans `#toast-region` avec `role="status"`.

### 12.2. SETUP — spécification détaillée

#### 12.2.1. Structure visuelle

```html
<section class="setup-screen screen" data-screen="setup" aria-labelledby="setup-title">
  <header class="hero-heading">
    <p class="eyebrow">QUIZ MULTIJOUEUR LOCAL</p>
    <h1 id="setup-title">Quizz <span>Canapé</span></h1>
    <p>Le savoir. La mauvaise foi. Le canapé.</p>
  </header>
  <form id="setup-form" novalidate>
    <fieldset class="panel players-panel">
      <legend>Les joueurs <span id="player-count-label">2/6</span></legend>
      <div id="players-list"></div>
      <button type="button" id="btn-add-player">+ Ajouter un joueur</button>
    </fieldset>
    <fieldset class="panel theme-panel">
      <legend>Le thème</legend>
      <div id="preset-themes" role="radiogroup"></div>
      <label for="custom-theme">Ou inventez le vôtre</label>
      <input id="custom-theme" maxlength="60" autocomplete="off" placeholder="Ex. les inventions improbables" />
    </fieldset>
    <fieldset class="panel settings-panel">
      <legend>Les règles</legend>
      <label for="target-score">Score cible : <output id="target-score-output">15</output></label>
      <input id="target-score" type="range" min="5" max="30" step="1" value="15" />
      <label class="switch-row"><input id="two-point-lead" type="checkbox" /> <span>Il faut 2 points d'écart pour gagner</span></label>
      <label class="switch-row"><input id="bonus-enabled" type="checkbox" /> <span>Activer les questions bonus ×2</span></label>
    </fieldset>
    <p id="setup-error" class="form-error" role="alert" hidden></p>
    <button id="btn-start" class="button button--primary button--large" type="submit" disabled>Générer la partie</button>
  </form>
</section>
```

#### 12.2.2. Joueurs

- Afficher 2 cartes à l'ouverture, jusqu'à 6.
- Chaque carte comporte : numéro, input prénom, bouton emoji cyclique, pastille couleur auto, bouton supprimer à partir de 3 joueurs.
- Prénoms obligatoires, trimés, longueur 1-18, uniques sans tenir compte de la casse.
- Émojis dans cette liste, cyclés par clic et clavier : `😀 🦊 🐼 🐸 🐙 🦄 🐯 🐨 🦁 🐵`.
- Couleurs auto dans l'ordre : violet, cyan, rose, lime, ambre, bleu. Ne pas réutiliser une couleur avant d'avoir épuisé la palette.
- `#btn-add-player` est désactivé à 6 ; message visible « 6 joueurs maximum ».
- Utiliser `aria-label="Choisir l'emoji de Alice"` et `aria-describedby` pour les erreurs.

#### 12.2.3. Thèmes

Afficher 8 thèmes prédéfinis sous forme de boutons radio : `Culture générale`, `Cinéma & séries`, `Musique`, `Sciences & nature`, `Histoire`, `Sport`, `Gastronomie`, `Jeux vidéo`. Ajouter une option « Thème libre » avec champ texte.

- Un clic sélectionne le thème et désélectionne le champ libre.
- Une saisie non vide dans le champ libre sélectionne automatiquement « Thème libre ».
- Validation : thème final non vide, longueur 2-60, aucun contrôle obligatoire sur les accents.

#### 12.2.4. Règles et démarrage

- Slider `targetScore` : min 5, max 30, pas 1 ; afficher la valeur instantanément.
- Toggle « 2 points d'écart » et toggle « question bonus double points ».
- Le bouton `Générer la partie` est activé seulement si : 2-6 joueurs, prénoms valides et uniques, thème valide, aucune génération en cours.
- À la soumission : sauvegarder joueurs et settings, désactiver le formulaire, afficher `LOADING`, lancer le lot initial.
- Afficher un texte de progression non mensonger : « Le maître des questions prépare 5 cartes… ».

#### Sélecteur de mode de jeu

Une rangée de cartes en tête du panneau de règles, suivie d'une carte « Créer ».
Cliquer sur une carte recopie les onze `MODE_RULE_KEYS` du mode **dans le formulaire**,
pas dans l'état : le formulaire reste la vérité jusqu'à la soumission.

- Le thème et l'article Wikipédia **ne sont pas touchés** — durcir les règles ne doit pas
  faire reperdre l'article qu'on venait de chercher.
- Le badge « modifié » se **calcule** (`diffFromMode`) à chaque saisie, il ne se stocke pas :
  un drapeau mentirait dès qu'on remet une valeur à sa position d'origine.
- Actions contextuelles : « Enregistrer comme nouveau mode », « Mettre à jour », « Annuler mes
  retouches », « Renommer », plus « Réinitialiser » (mode fourni retouché) ou « Supprimer »
  (mode perso). **Un mode fourni ne se supprime pas** : le semis le recréerait au rechargement.

#### Grille de choix d'avatar

Cliquer sur l'avatar d'un joueur ouvre une grille des 30 `PLAYER_EMOJIS`, **rangée pleine
largeur dans la grille de la carte** (`grid-column: 1 / -1`) et non flottant positionné :
pas de `z-index` à arbitrer entre les dix thèmes, rien qui déborde d'un conteneur à
`overflow` caché.

- Les avatars pris par un **autre** joueur sont `disabled`, pas masqués : on comprend pourquoi
  ils sont hors d'atteinte. Deux joueurs identiques rendraient l'attribution des points
  illisible.
- Fermeture par `Échap` ou clic à l'extérieur. Le focus part sur la première case libre à
  l'ouverture et **revient au déclencheur** à la fermeture, la grille ayant quitté le document.
- Chaque case porte son nom français (`PLAYER_EMOJI_LABELS`) : sans lui, un lecteur d'écran
  annonce « bouton » trente fois.
### 12.3. GAME — spécification détaillée

#### 12.3.1. Layout

```html
<section class="game-screen screen" data-screen="game" aria-labelledby="question-heading">
  <header class="game-header">
    <button id="btn-quit" class="button button--ghost">Quitter</button>
    <div class="progress"><span id="question-number"></span><div class="progress-bar"><span></span></div></div>
    <div id="leaderboard-mini" aria-label="Scores"></div>
  </header>
  <article id="question-card" class="question-card" aria-live="polite">
    <div class="question-meta"><span id="difficulty-badge"></span><span id="bonus-badge"></span></div>
    <h2 id="question-heading"></h2>
    <div id="options-grid" class="options-grid"></div>
  </article>
  <section id="answer-entry" class="answer-entry" aria-labelledby="answer-entry-title">
    <h3 id="answer-entry-title">Réponses des joueurs</h3>
    <div id="player-answer-grid"></div>
    <button id="btn-reveal" class="button button--primary button--large" disabled>Révéler la réponse</button>
  </section>
</section>
```

- Desktop : header horizontal, question centrée max-width 980 px, options en grille 2×2.
- Afficher le numéro (« Question 3 »), un indicateur non trompeur (« 3 préparées »), et le mini-classement trié par score.
- Ne pas afficher `answer`, `funnyOption` ou l'explication avant `REVEAL`.
- Les options sont de grandes cartes/boutons ≥ 44×44 px, avec lettre, texte, et un raccourci visible `1`, `2`, `3`, `4`.
- Les cartes sont lisibles à 3 m : texte minimum 1.25rem sur écran large.

#### 12.3.2. Saisie par le MJ

Pour chaque joueur, afficher une mini-carte avec emoji, prénom, score actuel, et quatre boutons A/B/C/D. Un seul choix est actif par joueur ; cliquer le même choix le désélectionne. Le bouton `Révéler` devient actif dès qu'au moins un joueur a une réponse ; recommander mais ne pas exiger une réponse de tous.

Raccourcis clavier :

| Touche | Action |
|--------|--------|
| `1`, `2`, `3`, `4` | Sélectionner respectivement A, B, C, D pour le joueur actuellement sélectionné |
| `Tab` | Passer au joueur / contrôle suivant selon l'ordre DOM naturel |
| `Entrée` | Confirmer la sélection du contrôle focalisé ; depuis le bouton Reveal, lancer la révélation |
| `Escape` | Fermer le toast/dialogue ou revenir à SETUP après confirmation |

- Le joueur actif est le dernier dont la carte a reçu le focus.
- Ne pas utiliser de listener clavier qui intercepte `Tab` globalement.
- Sur TV/clavier, le focus visible doit toujours indiquer la carte et le bouton actifs.
- En `QUESTION`, `REVEAL` est interdit si aucune réponse n'est saisie.

#### 12.3.3. Phase `REVEAL`

Après clic sur `Révéler la réponse` :

1. Bloquer tous les boutons de saisie.
2. Dispatcher `REVEAL_ANSWER` et calculer les points.
3. Sur la grille principale, colorer la bonne option en success (`--color-success`), la `funnyOption` en rose/cyan avec badge `OPTION DRÔLE`, les autres en muted.
4. Pour chaque joueur, afficher son choix, un marqueur ✓/✕/— et le delta `+1`, `+2` ou `+0`.
5. Afficher l'explication en 1-3 phrases sous les options.
6. Mettre à jour le mini-classement et faire pulser le leader.
7. Afficher `QUESTION SUIVANTE` ou `VOIR LE PODIUM` selon `hasVictory`.
8. Remettre le focus sur le bouton d'action suivant.

Couleurs : ne jamais utiliser la couleur seule ; ajouter texte, icône et attribut `aria-label`.

### 12.4. VICTORY — spécification détaillée

#### 12.4.1. Contenu

- Titre dynamique : `🏆 Alice gagne !` ; afficher le nombre de points et le score cible.
- Podium des 3 premiers (ou de tous s'il y en a moins) : médaille, rang, emoji, prénom, score, barre relative au leader.
- En cas d'égalité, afficher les deux scores et la règle de départage.
- Récapitulatif : thème, nombre de questions, bonnes réponses cumulées, durée approximative si mesurée.
- CTA principal `Rejouer` : conserve joueurs, thème et règles, retourne à `SETUP` avec scores remis à zéro.
- CTA secondaire `Changer les réglages` : retourne à SETUP et conserve joueurs.
- CTA tertiaire « Effacer les données locales » avec confirmation native `<dialog>`.

#### 12.4.2. Confettis

`confetti.js` crée un canvas positionné `fixed`, `pointer-events:none`, puis lance une animation de 2.5 s. Limiter à 120 particules, respecter `prefers-reduced-motion: reduce` en affichant au plus 20 particules immobiles/fade rapide. Appeler `stopConfetti()` au démontage pour annuler `requestAnimationFrame` et supprimer le canvas.

---

## 13. Design system

### 13.1. Variables CSS — thème complet

```css
/* src/styles/theme.css */
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap');

:root {
  color-scheme: dark;
  --font-sans: 'Outfit', 'Space Grotesk', system-ui, sans-serif;
  --bg-void: #0d0b1f;
  --bg-surface: #181530;
  --bg-surface-raised: #221d42;
  --bg-surface-soft: #2b2550;
  --color-accent-primary: #a855f7;
  --color-accent-cyan: #22d3ee;
  --color-accent-pink: #f472b6;
  --color-accent-lime: #a3e635;
  --color-success: #34d399;
  --color-error: #fb7185;
  --color-warning: #fbbf24;
  --color-text: #f0edff;
  --color-muted: #9d93c4;
  --color-border: rgba(240, 237, 255, .14);
  --color-overlay: rgba(13, 11, 31, .78);
  --glow-violet: 0 0 24px rgba(168, 85, 247, .35);
  --glow-cyan: 0 0 24px rgba(34, 211, 238, .28);
  --glow-success: 0 0 22px rgba(52, 211, 153, .35);
  --radius-sm: 8px;
  --radius-md: 14px;
  --radius-lg: 22px;
  --radius-xl: 32px;
  --shadow-card: 0 18px 50px rgba(0, 0, 0, .28);
  --transition-fast: 120ms ease;
  --transition-base: 220ms cubic-bezier(.2, .8, .2, 1);
  --transition-elastic: 520ms cubic-bezier(.34, 1.56, .64, 1);
  --space-1: .25rem;
  --space-2: .5rem;
  --space-3: .75rem;
  --space-4: 1rem;
  --space-5: 1.25rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --space-10: 2.5rem;
  --space-12: 3rem;
  --content-max: 1120px;
}

*, *::before, *::after { box-sizing: border-box; }
html { min-width: 320px; background: var(--bg-void); }
body {
  margin: 0; min-height: 100vh; background: var(--bg-void); color: var(--color-text);
  font-family: var(--font-sans); line-height: 1.45; -webkit-font-smoothing: antialiased;
}
button, input { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .45; }
:focus-visible { outline: 3px solid var(--color-accent-cyan); outline-offset: 3px; }
::selection { background: var(--color-accent-primary); color: white; }
```

### 13.2. Palette et usages

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-void` | `#0d0b1f` | fond principal |
| `--bg-surface` | `#181530` | panneau et barre |
| `--bg-surface-raised` | `#221d42` | carte et options |
| `--color-accent-primary` | `#a855f7` | CTA, sélection, marque |
| `--color-accent-cyan` | `#22d3ee` | focus, accents info |
| `--color-accent-pink` | `#f472b6` | humour, décoration |
| `--color-accent-lime` | `#a3e635` | bonus, énergie |
| `--color-success` | `#34d399` | correct, victoire |
| `--color-error` | `#fb7185` | incorrect, erreur |
| `--color-text` | `#f0edff` | texte principal |
| `--color-muted` | `#9d93c4` | texte secondaire |

### 13.3. Animations

| Nom | Déclencheur | Implémentation | Durée | Réduction motion |
|-----|-------------|----------------|-------|------------------|
| `question-enter` | affichage question | opacity 0 + translateY(16px) → visible | 520 ms elastic | opacity seulement 120 ms |
| `success-pulse` | bonne réponse / leader | box-shadow + scale 1.02 | 700 ms, 2 itérations | aucune |
| `error-shake` | mauvaise réponse | translateX alterné | 420 ms | aucune |
| `score-float` | gain de points | `+1` translateY(-32px) + fade | 900 ms | afficher texte statique |
| `leader-halo` | joueur en tête | halo violet/cyan pulsant | 1.8 s infini | halo statique |
| `confetti-fall` | victoire | canvas JS | 2.5 s | 20 particules max |

```css
@keyframes question-enter { from { opacity: 0; transform: translateY(16px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes success-pulse { 50% { transform: scale(1.02); box-shadow: var(--glow-success); } }
@keyframes error-shake { 20%, 60% { transform: translateX(-6px); } 40%, 80% { transform: translateX(6px); } }
@keyframes score-float { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(-32px); } }
@keyframes leader-halo { 50% { box-shadow: var(--glow-violet); } }

.question-card { animation: question-enter var(--transition-elastic); }
.answer-card--correct { animation: success-pulse 700ms ease 2; }
.answer-card--wrong { animation: error-shake 420ms ease; }
.score-float { animation: score-float 900ms ease forwards; }
.player-card--leader { animation: leader-halo 1.8s ease-in-out infinite; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; scroll-behavior: auto !important; }
}
```

### 13.4. Typographie

- Utiliser Outfit ; fallback Space Grotesk puis `system-ui`.
- `h1`: `clamp(2.5rem, 7vw, 5rem)`, poids 800, letter-spacing `-.04em`.
- `h2`: `clamp(1.5rem, 3.5vw, 3rem)`, poids 700.
- Body : 1rem minimum ; petit texte jamais inférieur à `.8125rem`.
- Le ratio texte/fond doit être ≥ 4.5:1 pour texte normal et ≥ 3:1 pour gros texte (WCAG AA). Vérifier les accents néon sur `--bg-surface` avant livraison.

### 13.5. Layout et responsive

| Breakpoint | Comportement |
|------------|--------------|
| `< 520px` | une colonne, options 1×4, header empilé, padding 16 px, cartes joueurs compactes |
| `520–767px` | setup en une colonne, options 2×2, grille réponses 2 colonnes |
| `768–1199px` | contenu max 960 px, setup deux colonnes, options 2×2 |
| `≥ 1200px` | contenu max 1120 px, grandes cartes, option TV-friendly |
| `≥ 1920px` | base font 18 px, max-width 1400 px, question max 1180 px |

```css
/* src/styles/layout.css */
.screen { width: min(100% - 2rem, var(--content-max)); margin-inline: auto; padding-block: var(--space-8); }
.setup-screen form { display: grid; gap: var(--space-6); }
@media (min-width: 768px) { .setup-screen form { grid-template-columns: repeat(2, minmax(0, 1fr)); } .setup-screen .players-panel, .setup-screen .settings-panel, .setup-screen #btn-start, .setup-screen .form-error { grid-column: 1 / -1; } }
.options-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
.player-answer-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-3); }
@media (max-width: 519px) { .screen { width: min(100% - 1.5rem, var(--content-max)); padding-block: var(--space-5); } .options-grid { grid-template-columns: 1fr; } }
```

### 13.6. Cibles et accessibilité

- Toute action utilisateur est un `<button>` ou un contrôle natif, jamais un `<div>` cliquable seul.
- Cible tactile minimum `44px × 44px`, espacement de 8 px minimum.
- Ajouter `aria-label` aux boutons iconographiques ; associer chaque label à son input.
- Utiliser `aria-live="polite"` pour scores et question ; `role="alert"` pour erreur bloquante.
- Maintenir un focus visible cyan de 3 px.
- Ne pas supprimer l'outline sans fournir un remplacement équivalent.
- Le contraste ne doit pas dépendre de la couleur : textes `Correct`, `Incorrect`, `Option drôle`, icônes et motifs doivent accompagner les couleurs.
- Respecter `prefers-reduced-motion` pour CSS et confettis JS.
- Tester clavier seul, zoom navigateur 200 %, largeur 320 px et lecteur d'écran basique.

---

## 14. `localStorage`

### 14.1. Clés exactes

```javascript
export const STORAGE_KEYS = {
  players: 'quizz-canape:players',
  settings: 'quizz-canape:settings',
  stats: 'quizz-canape:stats',
  activeSession: 'quizz-canape:active-session',
  llm: 'quizz-canape:llm',
};
```

Plus `quizz-canape:color-theme`, écrite par `themeSwitcher.js` et **absente de cette table** —
c'est pourquoi `wipeLocalStorage()` balaie par **préfixe** et non par cette liste figée.

**La clé API est stockée en clair** dans `quizz-canape:llm` en mode BYOK. C'est un écart
assumé par rapport au MVP, qui l'interdisait : sans lui, le mode « chacun son provider » est
impossible. Deux garde-fous en découlent :

- elle vit **hors de `settings`**, qui est recopié en entier dans chaque partie archivée et
  chaque instantané de reprise — elle s'y dupliquait indéfiniment ;
- le lien de partage (`shareConfig.js`) la contient **en clair** : base64url est un encodage,
  pas un chiffrement. L'URL est nettoyée par `history.replaceState` dès son import.

Pour un hébergement public, préférer la configuration serveur `.env`.

### 14.2. Schéma `quizz-canape:players`

```json
[
  { "id": "p1", "name": "Alice", "emoji": "🦊", "color": "#a855f7" },
  { "id": "p2", "name": "Bob", "emoji": "🐼", "color": "#22d3ee" }
]
```

Le score n'est pas persisté dans cette clé : il est toujours remis à zéro au début d'une partie.

### 14.3. Schéma `quizz-canape:settings`

```json
{
  "theme": "Cinéma & séries",
  "targetScore": 15,
  "twoPointLead": false,
  "bonusEnabled": false,
  "difficulty": "balanced",
  "audience": "general",
  "timerEnabled": true,
  "timePerQuestion": 60,
  "penaltyNoAnswer": false,
  "penaltyWrongAnswer": true,
  "punisherSeverity": "punitive",
  "manchesTarget": 1,
  "modeId": "epice",
  "sourceMode": "theme",
  "sourceTitle": "",
  "sourceLang": "fr",
  "sourceUrl": ""
}
```

**Aucun champ LLM ici** : ils vivent dans `quizz-canape:llm`. À l'hydratation, chaque valeur
est revalidée contre sa liste de choix — un `localStorage` bricolé à la main ne doit pas
injecter n'importe quoi dans une partie. `targetScore` est borné à 5-30.

`modeId` est un simple identifiant : on ne peut pas vérifier ici que le mode existe encore,
le catalogue vivant en IndexedDB et se lisant de façon asynchrone. Le sélecteur retombe sur
« personnalisé » s'il ne le retrouve pas.

L'article Wikipédia n'est **jamais** persisté, seulement ses identifiants : `saveSettings` est
appelé à chaque dispatch et le texte pèse plusieurs kilo-octets.

### 14.4. Schéma `quizz-canape:stats`

```json
{
  "gamesPlayed": 4,
  "questionsAnswered": 38,
  "correctAnswers": 21,
  "perPlayer": {
    "p1": { "name": "Alice", "emoji": "🦊", "gamesPlayed": 4, "wins": 2, "totalScore": 24 }
  }
}
```

### 14.5. Wrapper de stockage

```javascript
export function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`[storage] valeur ignorée pour ${key}`, error);
    localStorage.removeItem(key);
    return fallback;
  }
}

export function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (error) { console.warn('[storage] écriture impossible', error); }
}

export function savePlayers(players) { writeJson('quizz-canape:players', players.map(({ id, name, emoji, color }) => ({ id, name, emoji, color }))); }
export function saveSettings(settings) { writeJson('quizz-canape:settings', { theme: settings.theme, targetScore: settings.targetScore, twoPointLead: settings.twoPointLead, bonusEnabled: settings.bonusEnabled }); }
export function saveStats(stats) { writeJson('quizz-canape:stats', stats); }
export function clearAll() { ['quizz-canape:players', 'quizz-canape:settings', 'quizz-canape:stats'].forEach(k => localStorage.removeItem(k)); }
```

---

## 15. Gestion d'erreurs

### 15.1. Tableau cas → comportement

| Cas | Détection | Comportement technique | Message UI |
|-----|-----------|------------------------|------------|
| Clé absente | serveur démarre sans `LLM_API_KEY` | arrêter Vite avec erreur fatale ; ne jamais afficher l'app de jeu | « Configurez LLM_API_KEY dans .env côté serveur. » |
| Clé invalide | HTTP 401/403 | aucun retry ; rester en SETUP ou revenir à SETUP | « Clé LLM refusée. Vérifiez votre configuration serveur. » |
| URL provider invalide | fetch network / URL non valide au boot | erreur proxy 502 ; conserver l'état | « Provider LLM injoignable. » |
| Timeout | `AbortController` après 30 s navigateur | arrêter la tentative ; garder les questions en file | « Le provider est trop lent. Réessayez. » |
| JSON invalide | extraction/parse/validation échoue | 2 retries silencieux ; si échec, toast + retry manuel | « Le LLM a répondu dans un format inattendu. » |
| Lot incomplet | 1-`batchSize-1` questions valides | ajouter les valides ; demander complément au prochain seuil | « Quelques cartes n'ont pas pu être validées. » |
| Lot vide | zéro valide après retries | ne pas changer la question courante ; bouton réessayer | « Aucune question valide reçue. » |
| HTTP 429 | `res.status === 429` | backoff 2/4/8 s ; au-delà, erreur non fatale | « Trop de demandes ; nouvel essai possible. » |
| HTTP 5xx | status 500-599 | un retry après 2 s ; file conservée | « Le service de questions est indisponible. » |
| Offline initial | `navigator.onLine=false` | désactiver démarrage ; afficher état offline | « Connexion requise pour générer les questions. » |
| Offline en partie | événement `offline` | ne pas quitter la partie ; utiliser la file ; désactiver prefetch | « Hors connexion : les cartes déjà chargées restent disponibles. » |
| localStorage bloqué | exception `SecurityError`/quota | fonctionner en mémoire, warning console | « Les préférences ne peuvent pas être enregistrées. » |
| prénom invalide | formulaire SETUP | empêcher submit, focus sur premier champ erroné | « Saisissez un prénom unique (1 à 18 caractères). » |
| réponse partielle | certains joueurs sans choix | accepter, afficher `Pas de réponse`, révéler si ≥1 choix | « X joueur(s) sans réponse. Continuer ? » |
| erreur JS inattendue | `window.onerror`, `unhandledrejection` | log technique, toast générique, état préservé | « Une erreur est survenue. Réessayez ou rechargez. » |

### 15.2. Principes

- Les messages utilisateurs sont en français, courts, actionnables, sans stack trace ni URL secrète.
- Les erreurs détaillées sont loggées côté serveur ou `console.error` sans clé ni body complet.
- Ne jamais mettre une erreur dans `innerHTML` sans échappement ; construire le texte avec `textContent`.
- Un retry manuel doit pouvoir être lancé sans recharger et sans doubler les appels concurrents.
- Une erreur de prefetch n'interrompt pas une manche qui dispose encore de questions.

---

## 16. `package.json` et déploiement

### 16.1. Code complet

```json
{
  "name": "quizz-canape",
  "version": "0.1.0-beta",
  "private": true,
  "type": "module",
  "engines": { "node": "24.x" },
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "devDependencies": {
    "vite": "^5.4.0"
  }
}
```

### 16.1 bis. Versionnage

`engines.node` décide aussi de la version déployée sur Vercel : l'export `config` d'une
fonction `/api` n'accepte pas de numéro de runtime (`edge` | `experimental-edge` | `nodejs`
uniquement).

Le champ `version` est **incrémenté automatiquement** à chaque commit sur `dev` par
`.githooks/pre-commit`. Activation après clone : `git config core.hooksPath .githooks`.
Détail des garde-fous dans `AGENTS.md`.

La version affichée dans l'application vaut `<version>+<sha court>`, résolue au build par
`resolveVersion()` et figée par `define`. Le SHA est une **métadonnée de build** (`+`), pas un
identifiant de préversion (`.`) : un identifiant numérique ne peut pas commencer par zéro,
donc `0.1.0-beta.0123456` serait invalide là où `0.1.0-beta+0123456` reste correct.

### 16.2. Commandes

```bash
npm install
cp .env.example .env
# Renseigner LLM_API_KEY dans .env
npm run dev       # http://localhost:5173
npm run build     # génère dist/
npm run preview   # prévisualise dist/, avec avertissement ci-dessous
```

> ⚠️ **Avertissement déploiement : le build statique n'a pas de proxy.** `vite.config.js` configure le proxy du dev server, pas un serveur de production inclus dans `dist/`. En phase 2, déployer une fonction serverless ou un serveur Express qui implémente `/api/chat/completions`, charge `LLM_*` côté serveur et fait l'injection `Authorization`. Ne jamais remplacer ce proxy par une variable `VITE_LLM_API_KEY`.

### 16.3. Vérification build

Après `npm run build`, inspecter `dist/assets/*.js` et confirmer qu'aucune valeur de `LLM_API_KEY`, `Bearer`, ni contenu de `.env` n'est présente. Le build doit réussir sans avertissement bloquant ; `dist/index.html` doit charger les assets avec des chemins relatifs compatibles avec l'hébergement choisi.

---

## 17. Critères d'acceptation testables

Cocher chaque critère avec un test manuel ou automatisé reproductible.

1. [ ] `node --version` retourne une version ≥ 20.
2. [ ] `npm run dev` démarre sur le port annoncé et sert l'écran SETUP.
3. [ ] Avec `LLM_API_KEY` absent, le serveur refuse de démarrer et n'expose aucune page de jeu fonctionnelle.
4. [ ] Avec une clé valide, un appel navigateur à `/api/chat/completions` atteint le provider ; le navigateur ne voit jamais la clé.
5. [ ] Le code ne contient aucune variable `VITE_LLM_API_KEY`, `import.meta.env.LLM_API_KEY` ou token en dur.
6. [ ] Le setup affiche exactement 2 joueurs au départ.
7. [ ] L'ajout fonctionne jusqu'à 6 et est impossible au-delà.
8. [ ] La suppression n'est possible qu'à partir de 3 joueurs ; il est impossible de descendre sous 2.
9. [ ] Deux prénoms identiques après trim et casse sont refusés.
10. [ ] Un prénom vide ou de plus de 18 caractères empêche le démarrage.
11. [ ] Les émojis cyclent et leurs labels accessibles sont corrects.
12. [ ] Les couleurs auto sont distinctes pour six joueurs.
13. [ ] Les 8 thèmes prédéfinis sont visibles et sélectionnables.
14. [ ] Le thème libre sélectionne automatiquement le champ libre et valide 2-60 caractères.
15. [ ] Le slider accepte chaque entier de 5 à 30 et affiche sa valeur.
16. [ ] Les deux toggles sont persistés et restaurés au rechargement.
17. [ ] Le bouton démarrer est désactivé tant qu'un prérequis est invalide.
18. [ ] Le clic démarrer passe par `LOADING` puis affiche une question.
19. [ ] Le premier appel demande 5 questions, sauf configuration de batch explicitement différente.
20. [ ] Une question valide contient exactement `id`, `theme`, `difficulty`, `question`, `options`, `answer`, `funnyOption`, `explanation`.
21. [ ] `validateQuestion()` refuse 3 ou 5 options.
22. [ ] `validateQuestion()` refuse des clés autres que A/B/C/D ou dans un ordre différent.
23. [ ] `validateQuestion()` refuse `funnyOption === answer`.
24. [ ] Une question dont l'explication ne contient pas 1-3 phrases est refusée.
25. [ ] Un lot entouré de texte ou de fences ```json est parsé correctement.
26. [ ] Un JSON invalide déclenche au maximum 2 retries silencieux puis une erreur lisible.
27. [ ] Un 429 respecte le backoff 2 s, 4 s, 8 s puis expose une erreur.
28. [ ] Toute requête est abandonnée après 30 s côté navigateur.
29. [ ] La question 1 est affichée sans révéler sa réponse.
30. [ ] La grille contient exactement 4 options dans deux colonnes sur desktop.
31. [ ] Le MJ peut saisir A/B/C/D pour chaque joueur indépendamment.
32. [ ] Une réponse peut être désélectionnée ; aucune réponse n'est implicitement choisie.
33. [ ] `1`/`2`/`3`/`4` sélectionnent les options pour le joueur focalisé.
34. [ ] `Tab` suit l'ordre de focus naturel et `Entrée` active le bouton focalisé.
35. [ ] Révéler est impossible avec zéro réponse.
36. [ ] En reveal, la bonne option, la funnyOption, les choix joueurs et l'explication sont visibles.
37. [ ] Une bonne réponse donne +1 et une mauvaise/pas de réponse donne +0.
38. [ ] Une question bonus donne exactement +2 aux bonnes réponses.
39. [ ] Sans règle d'écart, atteindre la cible termine après reveal.
40. [ ] Avec règle d'écart, une avance inférieure à 2 ne termine pas la partie.
41. [ ] La partie passe à `VICTORY` au bon moment, jamais avant reveal.
42. [ ] Le podium trie les scores décroissants et gère les égalités.
43. [ ] Les confettis se lancent à VICTORY et s'arrêtent au démontage.
44. [ ] `prefers-reduced-motion: reduce` supprime les mouvements longs et réduit les confettis.
45. [ ] La génération du lot suivant commence à l'affichage de la question 3.
46. [ ] Aucun deuxième prefetch concurrent n'est lancé.
47. [ ] Les questions déjà affichées sont envoyées dans `exclude` et les doublons sont rejetés.
48. [ ] Une panne de prefetch ne perd pas les cartes déjà en file.
49. [ ] `quizz-canape:players`, `quizz-canape:settings` et `quizz-canape:stats` contiennent les schémas prescrits.
50. [ ] Aucune clé API ou valeur `Bearer` n'apparaît dans localStorage.
51. [ ] `npm run build` réussit.
52. [ ] Le build statique est explicitement marqué comme ne disposant pas du proxy de production.
53. [ ] À 320 px de large, aucun texte critique ni bouton n'est coupé.
54. [ ] À 200 % de zoom, les contrôles restent utilisables.
55. [ ] Toutes les cibles interactives font au moins 44 px.
56. [ ] Le focus clavier est visible sur tous les contrôles.
57. [ ] Les couleurs sont accompagnées de libellés/icônes et respectent AA.
58. [ ] Le jeu reste utilisable si un seul joueur ne répond pas.
59. [ ] `Rejouer` conserve les réglages mais remet les scores et questions à zéro.
60. [ ] L'effacement des données demande confirmation et supprime exactement les trois clés.

---

## 18. Checklist d'implémentation par phases

### Phase 1 — Socle technique

- [ ] Initialiser `package.json`, `index.html`, `vite.config.js`, `.env.example`, `.gitignore`.
- [ ] Installer Vite 5 avec Node 20+.
- [ ] Implémenter le proxy `/api` complet, validation `.env`, erreurs 4xx/5xx et timeout upstream.
- [ ] Créer `src/main.js` et un shell `#app`.
- [ ] Charger les trois feuilles CSS dans `main.js` ou `index.html`.
- [ ] Vérifier que la clé n'est jamais injectée dans le bundle.
- [ ] Ajouter `/api/health` et vérifier sa réponse sans secret.

### Phase 2 — Données et logique

- [ ] Implémenter `constants.js` : palette, émojis, thèmes, défauts.
- [ ] Implémenter `storage.js` avec parse défensif, quota handling et schémas.
- [ ] Implémenter `validation.js` et ses tests unitaires : contrat, ordre des keys, longueur, humour, réordonnancement.
- [ ] Implémenter `prompt.js` avec les deux textes prescrits et échappement des placeholders.
- [ ] Implémenter `api.js` : payload exact, extraction JSON, retries JSON, backoff 429, timeout 30 s.
- [ ] Implémenter `state.js`, `dispatch`, reducers et `subscribe`.
- [ ] Implémenter `hasVictory`, `computeWinner` et le multiplicateur bonus.
- [ ] Implémenter le préchargement initial de 5, seuil question 3, file et anti-doublon.
- [ ] Tester la machine `SETUP → LOADING → QUESTION → REVEAL → QUESTION/VICTORY → SETUP` avec faux provider.

### Phase 3 — Écrans fonctionnels

- [ ] Construire `screens/setup.js` avec formulaire, validation en direct, joueurs 2-6, émojis, couleurs.
- [ ] Construire `screens/game.js` avec question, grille 4 options, réponses par joueur et raccourcis clavier.
- [ ] Construire le reveal : couleurs, explication, delta par joueur, bouton suivant.
- [ ] Construire `screens/victory.js` avec podium, récapitulatif, rejouer et suppression confirmée.
- [ ] Connecter chaque écran aux actions du store et démonter proprement les listeners.
- [ ] Ajouter toasts, états de chargement, erreurs offline et retry manuel.

### Phase 4 — Finitions visuelles et accessibilité

- [ ] Implémenter `theme.css` avec tous les tokens prescrits.
- [ ] Implémenter `layout.css` et les quatre paliers responsive.
- [ ] Implémenter `components.css` : boutons, panels, toggles, cartes, badges, focus.
- [ ] Ajouter les cinq animations nommées et leur variante reduced-motion.
- [ ] Implémenter `confetti.js` avec nettoyage et limite de particules.
- [ ] Vérifier contrastes AA avec un outil d'audit et corriger les tokens si nécessaire.
- [ ] Tester clavier seul, lecteur d'écran, zoom 200 %, 320 px, tablette et écran TV.
- [ ] Tester offline avant partie et pendant partie.

### Phase 5 — QA et livraison

- [ ] Exécuter les 60 critères d'acceptation § 17 et consigner les résultats.
- [ ] Tester Mammouth avec la configuration par défaut.
- [ ] Tester OpenRouter et Groq avec URL/modèle adaptés.
- [ ] Tester Ollama local avec `http://localhost:11434/v1` et un modèle installé.
- [ ] Vérifier les réponses contenant texte avant JSON, fences, virgules trailing et enveloppe inattendue.
- [ ] Vérifier les 429, 401, 500, timeout et réseau coupé avec un mock.
- [ ] Exécuter `npm run build`, inspecter `dist/` et confirmer l'absence de secret.
- [ ] Documenter le déploiement phase 2 : fonction serverless ou Express, jamais clé dans le front.
- [ ] Livrer uniquement les fichiers nécessaires, sans `.env`.

---

## Annexe A — conventions de test minimales

Créer, si un runner est ajouté ultérieurement, des tests déterministes pour `validation.js` et le scoring. Injecter `rng: () => 0.5` afin de tester l'ordre sans flakiness. Mock de `fetch` :

```javascript
const fakeQuestion = {
  id: 'q_test_001',
  theme: 'test',
  difficulty: 'easy',
  question: 'Quelle couleur a le ciel par beau temps?',
  options: [
    { key: 'A', text: 'Bleu' },
    { key: 'B', text: 'Vert' },
    { key: 'C', text: 'Une soupe' },
    { key: 'D', text: 'Rouge' }
  ],
  answer: 'A',
  funnyOption: 'C',
  explanation: 'Par diffusion de la lumière dans l’atmosphère, le ciel paraît bleu.'
};

function mockOpenAiResponse(questions) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ questions }) } }]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

Cas minimum : question valide, option en double, `answer === funnyOption`, mauvais ordre de keys, batch vide, JSON fenced, 429 success après deux délais, timeout abort, victoire simple, victoire avec écart, bonus.

## Annexe B — garde-fous de livraison

- Ne jamais contourner le proxy pour appeler le provider depuis le navigateur.
- Ne jamais ajouter `VITE_` devant une variable sensible.
- Ne jamais faire confiance au JSON du LLM sans `extractJson()` puis `validateQuestion()`.
- Ne jamais afficher la bonne réponse dans le DOM avant la phase `REVEAL` ; éviter aussi de la placer dans des attributs accessibles visibles prématurément.
- Ne jamais faire dépendre la victoire d'une comparaison fragile de chaînes ; comparer les clés normalisées `A` à `D`.
- Ne jamais perdre l'état de jeu lors d'une erreur de prefetch.
- Ne jamais supposer que `navigator.onLine=true` garantit la disponibilité du provider.
- Ne jamais commiter `.env`, un dump de réponse LLM contenant une clé, ou des logs de secret.
- Ne jamais présenter le build `dist/` comme un déploiement fonctionnel tant qu'un endpoint serveur `/api` n'est pas fourni.

**Fin de la spécification.**
