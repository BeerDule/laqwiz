# AGENTS.md — Canap' QuiZZ

## Résumé
Jeu de quiz familial multijoueur (2-6) sur un seul écran, vanilla JS, zéro dépendance runtime.
Un maître du jeu (MJ) lit les questions et saisit les réponses de tout le monde.
Les questions sont générées par un LLM OpenAI-compatible via un proxy.

Deux modes de configuration LLM coexistent :
- **BYOK** (Bring Your Own Key) : le client renseigne URL, clé et modèle depuis l'écran
  **Paramètres** (`screens/settings.js`, accessible du menu principal), transmis via
  en-têtes `X-LLM-*` au proxy.
- **Serveur** : `.env` avec `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (repli si le client
  ne renseigne rien).

La configuration LLM est **globale à l'appareil**, hors de `settings` : celui-ci est
recopié en entier dans chaque partie archivée et chaque instantané de reprise, où la clé
API se retrouvait dupliquée indéfiniment. Elle vit dans sa propre tranche d'état et sa
propre clé `quizz-canape:llm`.

`LLM_CONFIG_REQUIRED` arbitre entre les deux : `false` dispense le joueur de saisir
quoi que ce soit, `true` l'y oblige, absent = obligatoire en production seulement.
**Figée à la compilation** — injectée par `define` dans `vite.config.js`, donc un
changement impose un rebuild. Sans ce drapeau à `false`, un serveur pourtant
configuré reste inatteignable : la validation du formulaire bloque avant l'appel.

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
plus `SESSIONS` (gestionnaire) et `SETTINGS` (réglages globaux de l'appareil), tous deux
accessibles depuis `HOME`.

Toute nouvelle phase doit être ajoutée **à la fois** dans `MOUNTERS` et `UNMOUNTERS` de `main.js`,
sinon l'écran reste blanc sans erreur.

### Modes de jeu

Un **mode** est un jeu de règles nommé. Le sélectionner recopie ses règles dans les
réglages de partie, qui restent librement retouchables ensuite — le badge passe alors à
« modifié ».

| Mode | Manches | Chrono | Pénalités | Public | Difficulté |
|---|---|---|---|---|---|
| 🍸 Canap' éritif | 1 | — | — | Tout public | Facile |
| 🌙 Canap' au lit | 1 | 1 min | — | Kid friendly | Facile |
| 🌶️ Canap' épicé **(défaut)** | 1 | 1 min | mauvaise réponse −1 | Tout public | Équilibré |
| 🔞 Canap' éro | 1 | 1 min | mauvaise réponse −1 | Adulte | Équilibré |
| 🔥 Canap' ocalypse | 3 | 30 s | −1 / −2 en bonus, sans réponse −1 | Tout public | Difficile |

Trois règles qui coûtent cher à redécouvrir :

- **`DEFAULTS` dérive du mode par défaut** (`...BUILTIN_MODES.find(…).settings`). Ne pas
  redéclarer les règles à deux endroits : elles divergeraient à la première retouche.
- **Corriger un mode fourni impose d'incrémenter sa `version`.** Le semis ne remplace un
  enregistrement que si sa version est antérieure ; sans incrément, la correction
  n'atteindra aucun appareil déjà ouvert.
- **Un mode fourni retouché par le MJ porte `dirty` et n'est jamais écrasé.** Sa retouche
  est délibérée, la nôtre ne l'est pas pour lui. Il garde « Réinitialiser » pour revenir
  aux valeurs d'origine. Les fournis ne sont pas supprimables — le semis les recréerait,
  et supprimer les cinq laisserait un écran sans issue.

Le badge « modifié » se **calcule** (`diffFromMode`, comparaison des onze `MODE_RULE_KEYS`),
il ne se stocke pas : un drapeau mentirait dès qu'on remet une valeur à sa position
d'origine. Sélectionner un mode ne touche qu'aux **règles** — le thème et l'article
Wikipédia survivent, pour qu'on puisse durcir les règles sans reperdre l'article choisi.

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
| `suddenDeathEnabled` + `suddenDeathStrikes` | mort subite : exclusion de la **manche** après 1 / 2 / 3 / 5 fautes |
| `modeId` | mode d'origine des règles ci-dessus — sert au badge « modifié », rien d'autre |

### Mort subite

Au seuil de fautes, le joueur est **exclu de la manche** — pas de la partie. Il revient à la
manche suivante, `freshScores()` remettant score, `strikes` et `eliminated` à zéro.

**Une absence de réponse compte comme une faute**, au même titre qu'une mauvaise : rester muet
ne doit pas être une stratégie de survie. C'est le seul endroit du code où les deux cas sont
traités à l'identique — ailleurs `penaltyNoAnswer` et `penaltyWrongAnswer` les distinguent.

Un exclu est sauté **en entier** dans `REVEAL_ANSWER` : ni gain, ni pénalité, ni comptage dans
`stats.questionsAnswered`. Son score est gelé. La saisie du MJ est verrouillée sur sa ligne,
avec une garde dans `selectAnswer()` en plus du `disabled` — le clavier contourne un attribut
posé au rendu.

**Le point qui casse tout si on l'oublie** : `hasMancheWinner()` exige normalement que
quelqu'un atteigne `targetScore`. Une manche où tout le monde est éliminé ne se terminerait
donc **jamais** — plus personne ne peut marquer. D'où la sortie anticipée :

- **un seul joueur debout → il remporte la manche sur-le-champ**, quel que soit son score,
  même si un exclu en a davantage ;
- **plateau vide** (tous tombés sur la même question) → le meilleur score tranche, l'ordre du
  roster départage les ex æquo.

`strikes` et `eliminated` partent dans l'instantané de reprise, sinon reprendre une partie
interrompue ressusciterait les éliminés.

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
  constants.js        # palettes, avatars, choix de réglages, BUILTIN_MODES, STORAGE_KEYS,
                      #   COLOR_THEMES, DEFAULTS
  modes.js            # gestionnaire de modes : semis versionné, CRUD, diffFromMode
  wikipedia.js        # recherche et découpage en fenêtre de sections (mode « article »)
  shareConfig.js      # encodage base64url de la config LLM dans une URL
  storage.js          # localStorage typé (roster, réglages, stats, LLM, id de session)
  db.js               # IndexedDB — sessions, parties, reprises, modes
  themeSwitcher.js    # thème de couleurs (data-color-theme)
  confetti.js         # animation de victoire
  screens/
    home.js           # menu principal (Continuer / Nouvelle session / Sessions / Réglages)
    setup.js          # roster + thème + règles + panneau LLM (BYOK)
    game.js           # question, saisie MJ, révélation, chrono, fin de manche
    victory.js        # podium de partie (classé sur les MANCHES gagnées) + confettis
    sessions.js       # gestionnaire : lister, créer, renommer, rouvrir, supprimer
    settings.js       # réglages GLOBAUX de l'appareil : LLM, partage d'URL, reset d'usine
  components/
    playerChip.js     # jeton de joueur avec info-bulle de nom (partagé par 3 écrans)
  styles/
    theme.css         # jetons + 10 thèmes de couleurs
    layout.css        # mise en page
    components.css    # composants
    arcade.css      # coquille « jeu vidéo » des écrans de menu (structure + jetons)
public/
  bubble-island/      # 15 PNG (1,4 Mo) découpés du pack craft/ — voir « Assets »
craft/                # pack d'assets brut (8,6 Mo) — matière première, non servie
demo/
  mock-llm.mjs        # faux LLM OpenAI-compatible en Node stdlib, zéro dep
```

(`.githooks/` contient le hook de versionnage, voir « Versionnage ».)

## Stockage : la répartition est volontaire

| Où | Quoi | Pourquoi |
|---|---|---|
| `localStorage` | roster, réglages, stats, thème, config LLM, **id** de session active | `main.js` hydrate **en synchrone avant le premier rendu** |
| IndexedDB (`db.js`) | sessions, parties, parties interrompues, **modes de jeu** | grossit sans limite ; lecture asynchrone hors du chemin de démarrage |

Quatre stores : `sessions`, `parties` (index `sessionId`), `resume` (clé = **id de partie**,
index `sessionId`) et `modes`. `DB_VERSION` vaut **4**.

**Reset d'usine** (écran Paramètres) : `clearArchive()` vide les stores dans **une seule
transaction
puis `wipeLocalStorage()` balaie le préfixe `quizz-canape:`, et la page se
recharge **immédiatement**. Trois points non négociables :

- On ne détruit plus la base (`deleteDatabase`). Détruire puis rouvrir dans une page qui va
  se recharger se bloquait indéfiniment dès qu'un autre onglet tenait la base : la
  réouverture se met en file derrière la suppression en suspens.
- L'archive d'abord. Si elle résiste, on s'arrête **avant** de toucher à `localStorage` :
  mieux vaut un appareil intact qu'un appareil à moitié réinitialisé.
- **Rien entre le wipe et le `reload()`.** L'abonné de `main.js` réécrit roster, réglages et
  clé API à chaque dispatch ; la moindre navigation dans l'intervalle ressuscitait ce qu'on
  venait d'effacer.

Les **modes de jeu sont conservés** par le reset (`keepModes: true` par défaut) : ce sont des
réglages composés par le MJ, pas des données de partie.

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

## Versionnage

Semver strict : `<version de package.json>+<sha court>`, par exemple
`0.1.0-beta+20b0c0a`. Affichée en pied du menu d'accueil — sur un déploiement,
c'est le seul moyen de savoir quel commit tourne quand un bug est signalé.

**Le SHA est une métadonnée de build (`+`), pas un identifiant de pré-version
(`.`).** Ce n'est pas cosmétique : un identifiant de pré-version purement
numérique ne peut pas commencer par zéro, donc un SHA court comme `0123456`
rendrait `0.1.0-beta.0123456` invalide, là où `0.1.0-beta+0123456` reste
correct. Environ un commit sur trois cents. La métadonnée de build est en outre
ignorée dans les comparaisons de précédence, ce qui est le comportement voulu.

Le numéro de base vit dans `package.json` (`"version"`), seul endroit à modifier
pour passer en `0.2.0-beta` ou `1.0.0`. Le SHA est résolu au build par
`resolveVersion()` dans `vite.config.js`, dans cet ordre :

1. `VERCEL_GIT_COMMIT_SHA` — le conteneur de build Vercel n'a pas forcément `git` ;
2. `git rev-parse --short HEAD` — en local, quand git est dans le PATH (ce n'est
   pas le cas par défaut dans le shell Nix, voir le gotcha plus bas) ;
3. la version nue, sans SHA — elle reste du semver valide, et un build ne doit
   pas échouer pour un numéro de version.

**Figée à la compilation** (`define`), comme `LLM_CONFIG_REQUIRED` : la version
affichée est celle du commit qui a produit le bundle, pas celle du dépôt courant.

### Incrément automatique du patch (hook `pre-commit`)

`.githooks/pre-commit` incrémente le patch de `package.json` à chaque commit **sur `dev`**
et l'ajoute au commit. `master` est la branche de déploiement : sa version arrive par
report depuis `dev`, elle ne doit pas dériver toute seule.

**Activation obligatoire après un clone** — `.git/hooks` n'est pas versionné :

```bash
git config core.hooksPath .githooks
```

`npm version patch` n'est **pas** utilisé : sur une préversion comme `0.1.0-beta`, npm
retire l'identifiant au lieu de l'incrémenter, ce qui publierait `0.1.0` — une version
stable annoncée par accident. `.githooks/bump-patch.mjs` fait un remplacement ciblé par
expression régulière, sans aller-retour `JSON.parse`/`stringify` qui reformaterait le
fichier entier et polluerait chaque commit d'un diff sans rapport.

Le hook s'abstient dans cinq cas :

| Cas | Pourquoi |
|---|---|
| branche ≠ `dev` | seule `dev` porte le compteur |
| merge, rebase, cherry-pick, revert | chaque commit rejoué ferait bondir la version d'autant de crans |
| `package.json` déjà mis en scène avec un changement de `version` | passage de mineure ou sortie de bêta : choix humain, on ne repasse pas derrière |
| `SKIP_VERSION_BUMP=1` | échappatoire explicite |
| `git commit --no-verify` | court-circuit natif de git |

**Limite connue** : `git commit --amend` sur `dev` incrémente une seconde fois. Il n'existe
pas de moyen fiable de détecter un amend depuis un hook. Utiliser
`SKIP_VERSION_BUMP=1 git commit --amend`.

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

### `arcade.css` ne porte plus aucune couleur
Ce fichier a longtemps figé l'identité Bubble Island sur les écrans de menu, quel que soit le
thème. **Ce n'est plus le cas** : il ne contient que de la structure et des jetons, zéro
couleur en dur, zéro sprite. Chaque thème est désormais purement lui-même, menus compris ;
les sprites propres à Paper Quest et Bubble Island vivent dans leurs blocs de `theme.css`.

### L'attribut `hidden` perd contre toute règle `display`
`[hidden] { display: none }` vient de la feuille du **navigateur**. N'importe quelle règle
**auteur** posant `display` la bat, même à spécificité égale — `el.hidden = true` était donc
sans effet visuel sur tout élément stylé en `display: grid/flex`. Cinq panneaux étaient
concernés. Un garde global dans `layout.css` règle la question :

```css
[hidden] { display: none !important; }
```

`!important` est ici l'intention même : aucune règle de présentation ne doit pouvoir
ressusciter un élément déclaré masqué. Ne pas ajouter de `display: … !important` ailleurs.

### Thème ≠ thème
`settings.theme` = le sujet du quiz (« Cinéma & séries »), envoyé au LLM.
`data-color-theme` = l'apparence. **10 thèmes** : VS Code, Matrix, Girly, Windows 98,
Jungle, Kids Friendly, Apple, Apple Glass, Bubble Island, **Paper Quest (défaut)**.
Ajouter un thème = une entrée dans `COLOR_THEMES` + un bloc de surcharges dans `theme.css`.
Aucun autre fichier à toucher.

### Les avatars de joueur sont choisis pour le contraste, pas au hasard
30 emoji dans `PLAYER_EMOJIS`, tous en **un seul point de code** : pas de séquence ZWJ qui
s'afficherait en plusieurs glyphes sur une police ancienne, et la comparaison stricte
utilisée par `nextEmoji()` reste fiable. Les pastels (panda, koala, licorne) ont été écartés :
leur contour se dissout sur les thèmes clairs, il ne reste que les yeux. `PLAYER_EMOJI_LABELS`
donne le nom français de chacun — sans lui, la grille de choix annonçait « bouton » 30 fois.

La grille (`emojiPickerHtml`) est une **rangée pleine largeur dans la grille de la carte**
(`grid-column: 1 / -1`), pas un flottant positionné : pas de `z-index` à arbitrer entre les
dix thèmes, rien qui déborde d'un conteneur à `overflow` caché.

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

**Le bouchon IndexedDB doit donner un `Map` PAR store**, chacun avec son `keyPath`
(`sessions`/`parties`/`modes` → `id`, `resume` → `partieId`). Un bouchon qui écrase tous les
stores dans une seule `Map` a déjà fait passer un test pour de mauvaises raisons et échouer
un autre pour de mauvaises raisons : l'enregistrement de session masquait l'instantané de
reprise portant la même clé.

Vérifier le **code de retour** de `npm run build`, jamais ses dernières lignes : une erreur
de bundling y affiche une trace de pile, pas un résumé.

## Historique git
Voir `git log`. (Ne pas recopier les commits ici : cette section a été fausse deux fois.)
