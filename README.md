# Quizz Canapé

Quiz familial multijoueur sur un même écran. Le maître du jeu (MJ) lit les
questions et saisit les réponses de chaque joueur. Les questions sont générées
à la volée par un LLM OpenAI-compatible, via un proxy qui garde la clé API hors
du navigateur.

2 à 6 joueurs. Zéro dépendance runtime, vanilla JS.

## Comment se joue une partie

```
session   vos joueurs + toutes les parties de la soirée
  partie  best-of 1, 3, 5 ou 7 manches — gagnée à la majorité
    manche course au score cible — les scores repartent de zéro
      question
```

Le score cible termine **une manche**, pas la partie : en best-of 5, il faut en
remporter 3. Le best-of s'arrête dès que la majorité est acquise.

Une session n'a pas de fin : c'est un sac à parties, avec son roster et son
historique de questions déjà posées. Elle survit au rechargement de la page et
reste consultable dans l'écran **Sessions**.

### Options
- **Chronomètre** — 30 s à 5 min par question. À zéro, la saisie se verrouille
  et le MJ garde la main pour révéler.
- **−1 point si pas de réponse** — sanctionne le silence.
- **Mode punisher** — −1 point sur une mauvaise réponse, ou −2 sur une question
  bonus en sévérité *ultra*.
- **Questions bonus ×2**, **écart de 2 points requis**, difficulté et public
  (kid friendly / tout public / adulte).

Aucun score ne descend sous zéro.

## Pré-requis

- Node.js ≥ 20 LTS
- Une clé API chez un provider OpenAI-compatible — ou rien du tout, voir la démo offline

## Démarrage

```bash
npm install
npm run dev       # http://localhost:5173
```

Chaque joueur peut renseigner son propre provider (URL, clé, modèle) depuis le
panneau **Modèle LLM** de l'écran de réglages : la clé reste dans son navigateur.

### Avec une configuration serveur

```bash
cp .env.example .env
# renseigner LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
npm run dev
```

### Démo offline, sans clé API

```bash
LATENCY_MS=4000 node demo/mock-llm.mjs &   # faux LLM local
npm run dev
```

## Production

```bash
npm run build     # génère dist/
npm run preview   # prévisualise dist/
```

Le déploiement cible Vercel : `vercel.json` réécrit `/api/*` vers la fonction
`api/gateway.js`, qui joue le rôle de proxy LLM côté serveur et injecte
l'en-tête `Authorization`. Ne **jamais** exposer une variable `VITE_LLM_API_KEY` :
tout ce qui porte le préfixe `VITE_` finit dans le bundle client.

> Le proxy de `vite.config.js` ne sert **que** le serveur de développement. En
> production, c'est `api/gateway.js` qui prend le relais — les deux implémentent
> le même contrat.

## Nix / NixOS

Le projet fournit un `flake.nix` (flakes requis) :

- `nix develop` — environnement de dev (Node.js 24 + npm)
- `nix build .#` — compile `dist/` de façon reproductible, sans nécessiter `.env`
- `nix flake check` — vérifie que le build passe

> Le projet est épinglé sur **Node.js 24** (LTS) : `engines.node` dans
> `package.json`, et `nodejs_24` dans le flake. Le même champ détermine la version
> utilisée par Vercel, dev et production restent donc alignés. Le
> `package-lock.json` est versionné pour figer `vite`.

## Architecture

| Fichier | Rôle |
|---------|------|
| `src/main.js` | Bootstrap, hydratation, routage des écrans |
| `src/state.js` | Store global, réducteur, machine à états, session/partie/manche |
| `src/api.js` | Client HTTP vers `/api` avec retries |
| `src/prompt.js` | Construction des prompts LLM |
| `src/validation.js` | Validation du contrat `Question` |
| `src/storage.js` | `localStorage` — roster, réglages, stats, session active |
| `src/db.js` | IndexedDB — archive des sessions et parties |
| `src/themeSwitcher.js` | Thème de couleurs |
| `src/confetti.js` | Animation de victoire |
| `src/screens/` | `home` · `setup` · `game` · `victory` · `sessions` |
| `src/styles/` | Design system (jetons, mise en page, composants, coquille arcade) |
| `api/gateway.js` | Proxy LLM serverless (production) |

Le petit état lu au démarrage vit en `localStorage` (lecture synchrone avant le
premier rendu) ; l'archive, qui grossit sans limite, vit en IndexedDB. Si le
navigateur refuse IndexedDB, le jeu fonctionne normalement — seul l'historique
des sessions est perdu.

## Thèmes

Neuf apparences au choix, commutables en cours de partie : **VS Code** (défaut),
Matrix, Girly, Windows 98, Jungle, Kids Friendly, Apple, Apple Glass et
**Bubble Island**, qui habille le jeu d'une interface de jeu vidéo à partir d'un
pack d'assets 9-slice (`public/bubble-island/`).

Tout passe par des variables CSS : ajouter un thème ne demande qu'une entrée dans
`COLOR_THEMES` et un bloc de surcharges dans `src/styles/theme.css`.
