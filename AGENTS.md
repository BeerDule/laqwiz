# AGENTS.md — Quizz Canapé

## Résumé
Jeu de quiz familial multijoueur (2-6), vanilla JS, zéro framework. Les questions sont générées par un LLM OpenAI-compatible via un proxy Vite. Deux modes de configuration LLM coexistent :
- **BYOK** (Bring Your Own Key) : chaque client renseigne son URL, clé et modèle depuis l'écran de configuration (stockage localStorage, transmis via en-têtes X-LLM-* au proxy).
- **Serveur** : `.env` avec `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (fallback si le client ne renseigne rien).

## Stack
- **Runtime** : Node ≥ 20 LTS (`fetch` natif, `AbortController`, ESM)
- **Bundler** : Vite 5.4 (`vite.config.js`)
- **Frontend** : Vanilla JS ES2022, CSS custom properties + `@layer`
- **Dép.** : **zéro dépendance npm runtime** — seul `vite` en devDependencies
- **Nix** : `flake.nix` pour shell reproductible + build

## Arborescence clé
```
.env                  # gitignored — optionnel (fallback serveur si BYOK absent)
.env.example          # modèle versionné
vite.config.js        # proxy HTTP → LLM (BYOK via en-têtes, fallback .env)
src/
  api.js              # fetchQuestionBatch(), extractJson(), retries
  state.js            # store pub/sub, machine à états (setup → loading → playing → reveal → victory)
  prompt.js           # buildSystemPrompt / buildUserPrompt (SPEC §8)
  validation.js       # validateQuestion(), parseQuestions() — contrat Question (SPEC §6)
  constants.js        # PLAYER_EMOJIS, PRESET_THEMES, QUESTION_SCHEMA_JSON, DEFAULTS
  screens/
    setup.js          # formulaire joueurs + thème + panneau LLM (BYOK)
    game.js           # question card + answer cards + reveal + timer
    victory.js        # écran de victoire + confetti
demo/
  mock-llm.mjs        # faux LLM OpenAI-compatible en Node stdlib, zéro dep
  README.md           # mode d'emploi démo offline
```

## Démarrer

### Sans configuration serveur (BYOK)
```bash
nix develop .#default
npm run dev
# → http://localhost:5173
# Chaque joueur renseigne son provider LLM depuis l'écran de config.
```

### Démo offline (mock local)
```bash
nix develop .#default
cd /home/westixy/dev
npm install                           # seulement la 1ère fois
LATENCY_MS=4000 node demo/mock-llm.mjs &  # terminal 1
npm run dev &                              # terminal 2
# → http://localhost:5173
```

### Avec config serveur (.env)
1. Copier `.env.example` → `.env`
2. Renseigner `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`
3. `npm run dev`

## Gotchas

### Configuration LLM (BYOK)
Le client peut renseigner son propre provider (URL, clé API, modèle, température) depuis le panneau « Modèle LLM » de l'écran de configuration. Ces valeurs sont transmises au proxy Vite via les en-têtes `X-LLM-Base-URL` et `X-LLM-Api-Key`. **Si ces en-têtes sont absents**, le proxy retombe sur les variables `.env` du serveur.

Le modèle suit la même règle : si le client envoie un champ `model` dans le body, il est conservé ; sinon le proxy injecte `LLM_MODEL`.

La clé API client est stockée dans `localStorage` (jamais dans `.env` côté serveur).

### Modèles reasoning (deepseek-v4-flash, etc.)
Les modèles reasoning génèrent du `reasoning_content` avant la réponse JSON.  
C'est coûteux et peut produire du JSON malformé.  
**Préférer `mistral-small`, `deepseek-v3`, ou `gpt-4o-mini`** pour du structured output fiable.

### Validation stricte
Chaque question doit avoir EXACTEMENT :
- `question` : string 10-240 chars, finit par `?`
- `options` : tableau de 4, keys `A`/`B`/`C`/`D`
- `explanation` : 20-280 chars
- `funnyOption != answer`

Si 0 question valide après 3 retries → `INVALID_JSON` → UI : *"Le LLM a répondu dans un format inattendu"*

### `.env` lu au démarrage de Vite uniquement
Toute modif de `.env` nécessite un redémarrage de Vite.  
Les modifications de `vite.config.js` sont détectées et rechargées à chaud par Vite.

### Clé API dans localStorage
En mode BYOK, la clé API est stockée en clair dans le `localStorage` du navigateur.
Pour un usage en famille c'est acceptable, mais un risque XSS subsiste.  
Si vous hébergez l'app pour des inconnus, préférez la config `.env` serveur.

### Pas de git dans le PATH par défaut
Utiliser `nix shell nixpkgs#git --command git ...`

## Historique git
```
022f802  point 0 – app quizz canapé + démo mock LLM offline
06efc2d  fix: proxy injecte le modèle LLM depuis .env + mistral-small + max_tokens 4096 + temp 0.7
```