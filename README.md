# Quizz Canapé

Quiz familial multijoueur sur un même écran. Le maître du jeu (MJ) lit les
questions et saisit les réponses de chaque joueur. Les questions sont générées
par un LLM OpenAI-compatible via un proxy serveur qui garde la clé API secrète.

## Pré-requis

- Node.js ≥ 20 LTS
- Une clé API chez un provider OpenAI-compatible (Mammouth par défaut)

## Démarrage

```bash
npm install
cp .env.example .env
# Renseigner LLM_API_KEY dans .env
npm run dev       # http://localhost:5173
```

## Production

```bash
npm run build     # génère dist/
npm run preview   # prévisualise dist/
```

> ⚠️ **Le build statique n'a pas de proxy.** `vite.config.js` configure le proxy
> du *dev server* uniquement. Pour déployer, fournir un endpoint serveur
> (`/api/chat/completions`) qui charge `LLM_*` côté serveur et injecte le header
> `Authorization`. Ne **jamais** utiliser une variable `VITE_LLM_API_KEY`.

## Nix / NixOS

Le projet fournit un `flake.nix` (flakes activés requis) avec :

- `nix develop` — environnement de dev (Node.js 22 + npm) ;
- `nix build .#` — compile le site statique `dist/` de façon reproductible
  (résultat dans `result/`, sans nécessiter `.env`) ;
- `nix flake check` — vérifie que le build passe.

```bash
# Développer
nix develop
npm install
cp .env.example .env   # puis renseigner LLM_API_KEY
npm run dev

# Compiler (équivalent reproductible de `npm run build`)
nix build .#
```

> Notes : `nodejs_20` étant EOL (marqué *insecure* dans nixpkgs), le flake
> utilise **Node.js 22** (LTS), qui satisfait `engines: node >= 20`. Le
> `package-lock.json` est versionné pour figer `vite` et ses dépendances.

## Architecture

| Fichier | Rôle |
|---------|------|
| `src/main.js` | Bootstrap, routage d'écrans, hydratation |
| `src/state.js` | Store global + pub/sub + machine à états |
| `src/api.js` | Client HTTP vers `/api` (proxy) avec retries |
| `src/prompt.js` | Construction des prompts LLM |
| `src/validation.js` | Validation du contrat `Question` |
| `src/storage.js` | Persistance `localStorage` |
| `src/confetti.js` | Animation de victoire |
| `src/screens/` | Écrans SETUP, GAME, VICTORY |
| `src/styles/` | Design system (tokens, layout, composants) |
