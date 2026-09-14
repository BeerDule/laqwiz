# Démo hors-ligne (sans LLM, sans clé)

`demo/mock-llm.mjs` est un faux provider OpenAI-compatible (Node stdlib,
zéro dépendance) qui renvoie 15 questions pré-écrites. Il permet de jouer
tout le flux du Quizz Canapé — setup → chargement → question → révélation →
victoire → rejouer — **sans clé API ni réseau**.

## Lancer la démo

Dans deux terminaux (depuis la racine du projet) :

```bash
# Terminal 1 — le faux LLM (port 8787)
node demo/mock-llm.mjs

# Terminal 2 — l'app (le .env pointe déjà sur le mock)
npm install
npm run dev     # http://localhost:5173
```

Ouvrez http://localhost:5173, ajoutez des joueurs, lancez la partie.

> Le fichier `.env` est temporairement configuré sur `http://127.0.0.1:8787/v1`.
> Pour revenir à un vrai provider, remettez vos valeurs réelles
> (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`) dans `.env`.

## Paramètres du mock

| Variable | Défaut | Rôle |
|----------|--------|------|
| `PORT` | `8787` | Port d'écoute |
| `LATENCY_MS` | `1200` | Latence artificielle (écran de chargement) |

Exemple : `PORT=9000 LATENCY_MS=300 node demo/mock-llm.mjs`
