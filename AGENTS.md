# AGENTS.md — Quizz Canapé

## Résumé
Jeu de quiz familial multijoueur (2-6) sur un seul écran, vanilla JS, zéro dépendance runtime.
Un maître du jeu (MJ) lit les questions et saisit les réponses de tout le monde.
Les questions sont générées par un LLM OpenAI-compatible via un proxy.

Deux modes de configuration LLM coexistent :
- **BYOK** (Bring Your Own Key) : le client renseigne URL, clé et modèle depuis l'écran de
  réglages (stockage `localStorage`, transmis via en-têtes `X-LLM-*` au proxy).
- **Serveur** : `.env` avec `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (repli si le client
  ne renseigne rien).

## Stack
- **Runtime** : Node 24 LTS (`fetch` natif, `AbortController`, ESM). Épinglé dans
  `engines.node` — c'est ce champ qui décide aussi de la version déployée sur
  Vercel, l'export `config` d'une fonction `/api` n'acceptant pas de numéro.
- **Bundler** : Vite 5.4 (`vite.config.js`)
- **Frontend** : Vanilla JS ES2022, CSS custom properties (pas de `@layer` — la cascade
  repose sur l'ordre des imports dans `main.js` : theme → layout → components → arcade)
- **Dép.** : **zéro dépendance npm runtime** — seul `vite` en devDependencies
- **Nix** : `flake.nix` pour shell reproductible + build
- ~5 800 lignes JS + CSS

## Modèle de jeu

Trois niveaux imbriqués. Se tromper de niveau est l'erreur la plus coûteuse ici.

```
session   roster de joueurs + sac de parties · AUCUNE condition de fin
  partie  best-of X manches, X impair (1, 3, 5, 7) · majorité des manches
          arrêt anticipé dès la majorité acquise
    manche course au `targetScore` (+ écart de 2 en option)
          scores RAZ à chaque manche, systématiquement
      question
```

- `targetScore` termine **une manche**, pas la partie. `hasMancheWinner()` ≠ `computePartieWinner()`.
- La session naît **implicitement** au premier `START_GAME`, ou explicitement via `NEW_SESSION`.
- L'anti-doublon de questions (`history`) est porté par la **session** : il survit d'une partie
  à l'autre et n'est vidé qu'avec une session neuve.

### Phases
`HOME` → `SETUP` → `LOADING` → `QUESTION` → `REVEAL` → `MANCHE_END` → (boucle) → `VICTORY`
plus `SESSIONS` (gestionnaire), accessible depuis `HOME` et `SETUP`.

Toute nouvelle phase doit être ajoutée **à la fois** dans `MOUNTERS` et `UNMOUNTERS` de `main.js`,
sinon l'écran reste blanc sans erreur.

### Options de partie
| Réglage | Effet |
|---|---|
| `manchesTarget` | best-of 1 / 3 / 5 / 7 |
| `targetScore` | points pour gagner une manche (5-30) |
| `twoPointLead` | il faut 2 points d'écart |
| `bonusEnabled` | ~15 % de questions ×2 (`BONUS_CHANCE`) |
| `timerEnabled` + `timePerQuestion` | chrono 30 s / 1-5 min ; à zéro la saisie se verrouille, le MJ révèle |
| `penaltyNoAnswer` | −1 si le joueur n'a pas répondu |
| `penaltyWrongAnswer` | mode punisher : −1 si mauvaise réponse |
| `punisherSeverity` | `punitive` (−1) ou `ultra` (−2 sur une question bonus) |

Toutes les pénalités passent par `applyPenalty()` : **plancher à 0**, la perte réellement
appliquée est enregistrée dans `roundPenalties` (l'écran de révélation l'affiche) et débitée
des stats, qui suivent donc le score net.

## Arborescence

```
.env                  # gitignored — optionnel (repli serveur si BYOK absent)
.env.example          # modèle versionné
vite.config.js        # proxy HTTP → LLM du DEV SERVER (BYOK via en-têtes, repli .env)
vercel.json           # rewrites : /api/* → /api/gateway
api/
  gateway.js          # proxy LLM serverless (production) — même contrat que le proxy Vite
src/
  main.js             # bootstrap, hydratation, routage des écrans, toasts
  state.js            # store pub/sub, réducteur, machine à états, session/partie/manche
  api.js              # fetchQuestionBatch(), extractJson(), retries
  prompt.js           # buildSystemPrompt / buildUserPrompt (SPEC §8)
  validation.js       # validateQuestion(), parseQuestions() — contrat Question (SPEC §6)
  constants.js        # palettes, choix de réglages, STORAGE_KEYS, COLOR_THEMES, DEFAULTS
  storage.js          # localStorage typé (roster, réglages, stats, id de session active)
  db.js               # IndexedDB — archive des sessions et parties
  themeSwitcher.js    # thème de couleurs (data-color-theme)
  confetti.js         # animation de victoire
  screens/
    home.js           # menu principal (Continuer / Nouvelle session / Sessions / Réglages)
    setup.js          # roster + thème + règles + panneau LLM (BYOK)
    game.js           # question, saisie MJ, révélation, chrono, fin de manche
    victory.js        # podium de partie (classé sur les MANCHES gagnées) + confettis
    sessions.js       # gestionnaire : lister, créer, renommer, rouvrir, supprimer
  styles/
    theme.css         # jetons + 9 thèmes de couleurs
    layout.css        # mise en page
    components.css    # composants
    arcade.css        # coquille « jeu vidéo » des écrans de menu
public/
  bubble-island/      # 15 PNG (1,4 Mo) découpés du pack craft/ — voir « Assets »
craft/                # pack d'assets brut (8,6 Mo) — matière première, non servie
demo/
  mock-llm.mjs        # faux LLM OpenAI-compatible en Node stdlib, zéro dep
```

## Stockage : la répartition est volontaire

| Où | Quoi | Pourquoi |
|---|---|---|
| `localStorage` | roster, réglages, stats, thème, **id** de session active | `main.js` hydrate **en synchrone avant le premier rendu** |
| IndexedDB (`db.js`) | sessions et parties archivées | grossit sans limite ; lecture asynchrone hors du chemin de démarrage |

**Ne pas déplacer l'hydratation vers IndexedDB** sans ajouter un état de démarrage : il n'y a pas
d'API synchrone, et le souscripteur de `main.js` écrit à chaque dispatch.

## Démarrer

### Démo offline (mock local, sans clé API)
```bash
nix develop .#default
npm install                                # seulement la 1ère fois
LATENCY_MS=4000 node demo/mock-llm.mjs &   # terminal 1
npm run dev &                              # terminal 2
# → http://localhost:5173
```

### BYOK (chaque joueur renseigne son provider)
```bash
nix develop .#default
npm run dev
```

### Config serveur (.env)
1. `cp .env.example .env`
2. Renseigner `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`
3. `npm run dev`

## Gotchas

### Le chrono ne doit jamais passer par `dispatch()`
Le souscripteur de `main.js` appelle `savePlayers` + `saveSettings` à **chaque** dispatch.
Un tick par seconde ferait deux écritures `localStorage` par seconde pendant toute la partie.
Le décompte vit en local dans `game.js` et ne dispatche qu'à l'expiration.
Il vise une **échéance** (`Date.now() + durée`) et non un compteur décrémenté : `setInterval`
dérive et se fait brider quand l'onglet passe en arrière-plan.

### `border-image` ne réserve pas d'espace
Les cadres 9-slice (thème Bubble Island, `arcade.css`) peignent vers l'intérieur **par-dessus**
le padding. Tout élément encadré doit avoir `padding ≥ border-image-width`, sinon le cadre
recouvre le texte. Les rayons de coin ont été mesurés sur l'alpha des PNG, pas estimés :
pilules `slice 350`, cadres `slice 110`, boutons ronds `slice 348` + `border-image-width: 50%`.

### `db.js` avale ses erreurs, et c'est voulu
L'archive est un confort, pas une dépendance. Un navigateur en navigation privée qui refuse
IndexedDB doit laisser la partie se dérouler normalement. Ne pas transformer ces `catch` en
erreurs remontées à l'UI.

### La reprise de session est asynchrone — la garde est nécessaire
`main.js` lit la session active en arrière-plan. Sans la vérification de phase, un utilisateur
qui lance une partie avant que la lecture réponde se ferait renvoyer aux réglages.

### `arcade.css` fige ses couleurs hors des jetons, et c'est voulu
Les écrans de menu gardent l'identité Bubble Island quel que soit le thème sélectionné.
Reprendre les jetons y rendrait le texte illisible en Matrix ou Win98, où les valeurs partent
dans l'autre sens. Les écrans **de jeu**, eux, suivent bien le thème.

### Thème ≠ thème
`settings.theme` = le sujet du quiz (« Cinéma & séries »), envoyé au LLM.
`data-color-theme` = l'apparence. 9 thèmes : VS Code, Matrix, Girly, Windows 98, Jungle,
Kids Friendly, Apple, Apple Glass, Bubble Island. Ajouter un thème = une entrée dans
`COLOR_THEMES` + un bloc de surcharges dans `theme.css`. Aucun autre fichier à toucher.

### Modèles reasoning (deepseek-v4-flash, etc.)
Ils génèrent du `reasoning_content` avant la réponse JSON : coûteux, et souvent du JSON malformé.
**Préférer `mistral-small`, `deepseek-v3` ou `gpt-4o-mini`** pour du structured output fiable.

### Validation stricte
Chaque question doit avoir EXACTEMENT :
- `question` : string 10-240 chars, finit par `?`
- `options` : tableau de 4, clés `A`/`B`/`C`/`D`
- `explanation` : 20-280 chars
- `funnyOption != answer`

0 question valide après 3 retries → `INVALID_JSON` → UI : *« Le LLM a répondu dans un format inattendu »*

### `.env` lu au démarrage de Vite uniquement
Toute modif de `.env` nécessite un redémarrage. `vite.config.js` est rechargé à chaud.

### Clé API en clair dans `localStorage` (mode BYOK)
Acceptable en famille, mais un risque XSS subsiste. Pour un hébergement public, préférer la
config `.env` serveur.

### Deux proxys à maintenir en parallèle
`vite.config.js` (dev) et `api/gateway.js` (production Vercel) implémentent le **même** contrat
BYOK/repli. Toute évolution doit toucher les deux.

### Pas de git dans le PATH par défaut
`nix shell nixpkgs#git --command git ...`

## Tests

Il n'y a **pas de framework de test** dans le projet. La logique de `state.js` se teste en
important le module dans Node avec `localStorage` et `navigator` bouchonnés :

```js
globalThis.localStorage = { _d:{}, getItem(k){return this._d[k]??null},
  setItem(k,v){this._d[k]=String(v)}, removeItem(k){delete this._d[k]}, clear(){this._d={}} };
Object.defineProperty(globalThis, 'navigator', { value:{onLine:true}, configurable:true });
globalThis.indexedDB = undefined;   // vérifie aussi le repli sans archive
const { getState, dispatch } = await import('./src/state.js');
```

Attention : `navigator` n'est pas assignable directement sous Node 22, d'où `defineProperty`.
`START_GAME` déclenche un appel réseau — pour tester la boucle de jeu, monter `s.session` et
`s.partie` à la main plutôt que de le dispatcher.

## Historique git
Voir `git log`. (Ne pas recopier les commits ici : cette section a été fausse deux fois.)
