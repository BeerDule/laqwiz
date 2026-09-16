# Spécification fonctionnelle et technique  
## Système de sessions de jeu avec relais WebSocket

**Version :** 1.0  
**Date :** 16 septembre 2026

---

> **Canap' QuiZZ** : ce document décrit le relais générique (sections 1 à 17). La **section 18** l'adapte au jeu de quiz — rôles host/player, messages métier, projection de sécurité, déploiement Vercel vs auto-hébergé, terrain de reprise. Elle **fait foi pour la partie en ligne**.

## 1. Objectif

Le système permet à un utilisateur, appelé **joueur A**, de créer une session de jeu et de partager une URL avec un ou plusieurs autres utilisateurs, appelés **joueurs B**.

Chaque navigateur se connecte au serveur Node.js via WebSocket. Le serveur agit comme une **passerelle de communication** :

- il identifie les connexions appartenant à une même session ;
- il reçoit les messages des clients ;
- il les transmet aux autres clients de la session ;
- il ne contient pas nécessairement la logique métier du jeu.

---

## 2. Principe général

```text
Navigateur A
    │
    │ 1. Création de session via HTTP
    ▼
Serveur Node.js
    │
    │ 2. Génération d'un identifiant
    ▼
URL de partage
    │
    ├── Navigateur A
    │       │
    │       │ WebSocket
    │       ▼
    │   Serveur Node.js
    │
    └── Navigateur B
            │
            │ WebSocket
            ▼
        Serveur Node.js
```

Une session est identifiée par un identifiant aléatoire, par exemple :

```text
a8f3b2c1d9e7456f91a0c2345e78b321
```

Cet identifiant est inclus dans une URL :

```text
https://example.com/game/a8f3b2c1d9e7456f91a0c2345e78b321
```

Tous les navigateurs utilisant cette URL rejoignent la même session.

---

# 3. Composants du système

## 3.1 Frontend navigateur

Le frontend est développé en Vanilla JavaScript.

Il est responsable de :

- demander la création d'une session ;
- afficher ou copier l'URL de partage ;
- extraire l'identifiant de session depuis l'URL ;
- ouvrir la connexion WebSocket ;
- envoyer les actions de l'utilisateur ;
- recevoir les événements relayés par le serveur ;
- afficher l'état du jeu ;
- gérer les reconnexions.

Le frontend ne doit pas générer seul un identifiant considéré comme fiable. L'identifiant officiel est généré par le serveur.

---

## 3.2 Serveur Node.js

Le serveur expose deux types d'interfaces :

### API HTTP

Utilisée pour créer une session.

Exemple :

```http
POST /api/sessions
```

### Serveur WebSocket

Utilisé pour les communications temps réel.

Exemple :

```text
wss://example.com/ws?sessionId=SESSION_ID
```

Le serveur conserve temporairement une structure équivalente à :

```js
Map<sessionId, Set<WebSocket>>
```

Exemple conceptuel :

```text
session-123
  ├── connexion WebSocket du joueur A
  └── connexion WebSocket du joueur B
```

---

## 3.3 Session

Une session représente un espace de communication isolé.

Elle contient au minimum :

```js
{
  id: "session-123",
  clients: Set<WebSocket>,
  createdAt: Date,
  lastActivityAt: Date
}
```

Selon les besoins, elle peut également contenir :

```js
{
  hostPlayerId: "...",
  maxPlayers: 2,
  status: "waiting",
  metadata: {}
}
```

---

# 4. Cycle de vie d'une session

## 4.1 Création par le joueur A

Le joueur A arrive sur l'application et clique sur :

```text
Créer une partie
```

Le frontend envoie :

```http
POST /api/sessions
```

Le serveur :

1. génère un identifiant aléatoire ;
2. crée une session en mémoire ;
3. associe le joueur A comme créateur ;
4. renvoie les informations de connexion.

Réponse :

```json
{
  "sessionId": "a8f3b2c1d9e7456f91a0c2345e78b321",
  "shareUrl": "https://example.com/game/a8f3b2c1d9e7456f91a0c2345e78b321"
}
```

Le frontend affiche ensuite :

```text
Partagez cette URL avec l'autre joueur :
https://example.com/game/a8f3b2c1d9e7456f91a0c2345e78b321
```

---

## 4.2 Connexion de A en WebSocket

Le navigateur A ouvre une connexion :

```text
wss://example.com/ws?sessionId=a8f3b2c1d9e7456f91a0c2345e78b321
```

Le serveur :

1. lit le `sessionId` ;
2. vérifie que la session existe ;
3. ajoute la connexion à la session ;
4. attribue éventuellement un identifiant de joueur ;
5. informe les clients déjà connectés.

Événement envoyé à A :

```json
{
  "type": "session.connected",
  "sessionId": "a8f3b2c1d9e7456f91a0c2345e78b321",
  "playerId": "player-a",
  "playersCount": 1
}
```

---

## 4.3 Connexion de B

Le joueur B ouvre l'URL reçue :

```text
https://example.com/game/a8f3b2c1d9e7456f91a0c2345e78b321
```

Le frontend extrait l'identifiant depuis l'adresse :

```js
const sessionId = location.pathname.split("/").pop();
```

Puis il ouvre la connexion WebSocket :

```text
wss://example.com/ws?sessionId=a8f3b2c1d9e7456f91a0c2345e78b321
```

Le serveur vérifie :

- que la session existe ;
- que la session n'est pas pleine ;
- que le client est autorisé à entrer.

Le serveur ajoute B à la session et informe A et B.

Événement :

```json
{
  "type": "player.joined",
  "playerId": "player-b",
  "playersCount": 2
}
```

---

## 4.4 Communication entre les clients

Lorsqu'un client souhaite envoyer une action, il transmet un message JSON au serveur.

Exemple :

```json
{
  "type": "game.move",
  "payload": {
    "position": 4
  }
}
```

Le serveur :

1. reçoit le message ;
2. vérifie qu'il est valide ;
3. identifie la session associée à la connexion ;
4. ajoute éventuellement les informations serveur ;
5. relaie le message aux autres clients de la session.

Message reçu par l'autre client :

```json
{
  "type": "game.move",
  "payload": {
    "position": 4
  },
  "senderId": "player-a"
}
```

Le serveur peut exclure l'expéditeur ou renvoyer le message à tous les clients, selon le comportement souhaité.

---

## 4.5 Déconnexion

Lorsqu'un client ferme son navigateur ou perd la connexion :

1. le serveur reçoit l'événement de fermeture ;
2. il retire la connexion de la session ;
3. il informe les autres clients ;
4. il met à jour le nombre de joueurs ;
5. il supprime éventuellement la session si elle est vide.

Message envoyé aux clients restants :

```json
{
  "type": "player.left",
  "playerId": "player-b",
  "playersCount": 1
}
```

---

## 4.6 Expiration d'une session

Une session doit être supprimée lorsqu'elle n'est plus utilisée.

Exemples de règles :

- suppression immédiate si aucun client n'est connecté ;
- expiration après 30 minutes sans activité ;
- durée maximale de 4 heures ;
- suppression manuelle par le créateur.

Exemple :

```text
Session créée : 14:00
Dernière activité : 14:45
Expiration après 30 minutes
Suppression : 15:15
```

---

# 5. Protocole de messages

Tous les messages WebSocket utilisent le format JSON.

Format général :

```json
{
  "type": "string",
  "payload": {},
  "requestId": "string optionnel"
}
```

## 5.1 Types de messages système

### Connexion acceptée

```json
{
  "type": "session.connected",
  "payload": {
    "sessionId": "session-123",
    "playerId": "player-abc"
  }
}
```

### Joueur connecté

```json
{
  "type": "player.joined",
  "payload": {
    "playerId": "player-xyz"
  }
}
```

### Joueur déconnecté

```json
{
  "type": "player.left",
  "payload": {
    "playerId": "player-xyz"
  }
}
```

### Erreur

```json
{
  "type": "error",
  "payload": {
    "code": "SESSION_FULL",
    "message": "La session est complète."
  }
}
```

---

## 5.2 Types de messages métier

Les messages métier dépendent du jeu.

Exemples :

```json
{
  "type": "game.start",
  "payload": {}
}
```

```json
{
  "type": "game.move",
  "payload": {
    "from": 2,
    "to": 5
  }
}
```

```json
{
  "type": "game.chat",
  "payload": {
    "message": "À toi de jouer !"
  }
}
```

Le serveur peut relayer ces messages sans en comprendre le contenu, ou effectuer des validations minimales.

---

# 6. API HTTP

## 6.1 Créer une session

### Requête

```http
POST /api/sessions
Content-Type: application/json
```

### Réponse réussie

```http
201 Created
Content-Type: application/json
```

```json
{
  "sessionId": "session-123",
  "shareUrl": "https://example.com/game/session-123"
}
```

### Erreurs possibles

```json
{
  "error": "SESSION_CREATION_FAILED",
  "message": "Impossible de créer la session."
}
```

---

## 6.2 Vérifier une session

Cette route est facultative.

```http
GET /api/sessions/session-123
```

Réponse :

```json
{
  "exists": true,
  "status": "waiting",
  "playersCount": 1,
  "maxPlayers": 2
}
```

Cette vérification peut être utilisée avant l'ouverture du WebSocket.

---

# 7. Connexion WebSocket

## 7.1 URL

```text
wss://example.com/ws?sessionId={sessionId}
```

Exemple :

```text
wss://example.com/ws?sessionId=session-123
```

## 7.2 Conditions d'acceptation

La connexion est acceptée uniquement si :

- `sessionId` est présent ;
- le format de `sessionId` est valide ;
- la session existe ;
- la session n'est pas expirée ;
- le nombre maximal de joueurs n'est pas atteint.

## 7.3 Fermeture avec code

Exemples :

| Code | Signification |
|---:|---|
| `1000` | Fermeture normale |
| `1008` | Connexion non autorisée |
| `1009` | Message trop volumineux |
| `1011` | Erreur interne du serveur |

---

# 8. Routage des messages

Le serveur associe chaque WebSocket à une session.

```text
Connexion A → session-123
Connexion B → session-123
Connexion C → session-456
```

Un message de A doit être envoyé uniquement aux clients de `session-123`.

```text
A ── message ──> serveur
                  │
                  └──> B

C ne reçoit rien
```

Le serveur ne doit jamais diffuser un message à toutes les connexions globales sans vérifier la session.

---

# 9. Gestion de l'identité des joueurs

Chaque connexion peut recevoir un identifiant temporaire :

```text
playerId = player-8b1c...
```

Cet identifiant est utilisé pour :

- identifier l'expéditeur ;
- informer les autres clients ;
- gérer les départs ;
- différencier les joueurs.

Exemple :

```json
{
  "type": "game.move",
  "senderId": "player-a",
  "payload": {
    "position": 4
  }
}
```

Le `senderId` doit être ajouté par le serveur, et non accepté directement depuis le message du client.

---

# 10. Sécurité

## 10.1 Identifiants imprévisibles

Les identifiants doivent être générés avec un générateur cryptographique :

```js
crypto.randomBytes(32).toString("hex");
```

Il ne faut pas utiliser :

```text
session-1
session-2
session-3
```

## 10.2 Validation des messages

Le serveur doit vérifier :

- que le JSON est valide ;
- que le champ `type` existe ;
- que le type est autorisé ;
- que le payload respecte le schéma attendu ;
- que la taille du message est raisonnable.

## 10.3 Limitation de fréquence

Le serveur doit limiter le nombre de messages par client.

Exemple :

```text
Maximum : 20 messages par seconde et par connexion
```

Cela évite qu'un client monopolise le serveur.

## 10.4 Transport sécurisé

En production :

```text
HTTPS  → https://example.com
WebSocket sécurisé → wss://example.com
```

L'utilisation de `ws://` est acceptable uniquement en développement local.

## 10.5 Contrôle d'accès

Le simple fait de posséder l'URL donne accès à la session.

Ce fonctionnement est acceptable pour une partie privée simple, mais il faut utiliser un token supplémentaire si la session contient des données sensibles.

---

# 11. États possibles d'une session

```text
CREATED
   │
   ▼
WAITING
   │
   │ un ou plusieurs joueurs connectés
   ▼
ACTIVE
   │
   │ fin de partie ou fermeture
   ▼
FINISHED
   │
   ▼
EXPIRED
```

Exemple :

| État | Description |
|---|---|
| `CREATED` | Session créée mais aucun client connecté |
| `WAITING` | Le créateur attend d'autres joueurs |
| `ACTIVE` | La communication ou le jeu est en cours |
| `FINISHED` | La session est terminée |
| `EXPIRED` | La session a été supprimée |

---

# 12. Reconnexion

Une déconnexion réseau peut être temporaire.

Le frontend doit essayer de se reconnecter :

```text
Tentative 1 : après 1 seconde
Tentative 2 : après 2 secondes
Tentative 3 : après 5 secondes
Tentative 4 : après 10 secondes
```

Le serveur doit pouvoir reconnaître le joueur à l'aide d'un identifiant temporaire ou d'un token de reconnexion.

Sans mécanisme spécifique, une reconnexion sera considérée comme un nouveau client.

---

# 13. Heartbeat

Pour détecter les connexions mortes, le serveur peut envoyer périodiquement un ping.

```text
Serveur → ping
Client → pong
```

Exemple :

```text
Intervalle : 30 secondes
Délai maximal de réponse : 10 secondes
```

Si un client ne répond plus, le serveur ferme la connexion.

---

# 14. Persistance et caractère stateless

Le serveur ne conserve pas nécessairement les données de jeu de manière permanente.

Cependant, il doit garder temporairement les connexions actives :

```text
sessionId → connexions WebSocket
```

Le système est donc :

- **sans état métier persistant**, si aucun état de jeu n'est sauvegardé ;
- **avec état de connexion temporaire**, indispensable au fonctionnement de WebSocket.

Avec une seule instance Node.js, une structure en mémoire suffit.

Avec plusieurs instances, il faudra prévoir :

- des sessions persistantes ;
- Redis Pub/Sub ;
- des connexions persistantes vers la même instance ;
- ou un service WebSocket dédié.

> **Canap' QuiZZ** : cas retenu = **plusieurs instances** (Vercel Functions). Voir §18.6 pour l'architecture Redis (état + pub/sub).

---

# 15. Scénario nominal complet

```text
1. A ouvre le site.
2. A clique sur "Créer une session".
3. Le frontend appelle POST /api/sessions.
4. Le serveur génère sessionId.
5. Le serveur renvoie l'URL de partage.
6. A ouvre une connexion WebSocket.
7. A partage l'URL à B.
8. B ouvre l'URL.
9. B ouvre une connexion WebSocket avec le même sessionId.
10. Le serveur associe A et B à la même session.
11. A envoie une action.
12. Le serveur relaie l'action à B.
13. B répond.
14. Le serveur relaie la réponse à A.
15. Un joueur quitte.
16. Le serveur informe l'autre joueur.
17. La session est supprimée lorsqu'elle expire.
```

---

# 16. Critères d'acceptation

Le système est considéré comme fonctionnel lorsque :

- A peut créer une session ;
- une URL de partage est générée ;
- B peut rejoindre la session avec cette URL ;
- A et B sont connectés en WebSocket ;
- un message envoyé par A est reçu par B ;
- un message envoyé par B est reçu par A ;
- les clients d'une autre session ne reçoivent pas les messages ;
- une session inexistante est refusée ;
- une session pleine est refusée ;
- une déconnexion est détectée ;
- une session inactive est supprimée ;
- les messages invalides sont rejetés ;
- les connexions utilisent `wss://` en production.

---

# 17. Résumé de l'architecture cible

```text
┌──────────────────────────┐
│ Navigateur A             │
│ Vanilla JS               │
└────────────┬─────────────┘
             │ HTTPS
             ▼
┌──────────────────────────┐
│ API Node.js              │
│ POST /api/sessions       │
└────────────┬─────────────┘
             │
             │ sessionId
             ▼
┌──────────────────────────┐
│ Serveur WebSocket        │
│                          │
│ sessionId → clients      │
│                          │
│ Relais des messages      │
└───────┬──────────┬───────┘
        │          │
        │ WebSocket│ WebSocket
        ▼          ▼
┌────────────┐ ┌────────────┐
│ Joueur A   │ │ Joueur B   │
└────────────┘ └────────────┘
```

Le principe central est donc :

> **Le serveur crée une session, associe les connexions WebSocket à cette session et relaie uniquement les messages entre les clients appartenant à cette même session.**

---

# 18. Adaptation à Canap' QuiZZ (multijoueur en ligne)

Cette section adapte le relais générique (sections 1 à 17) au quiz Canap' QuiZZ.
Elle est la source de vérité pour la partie en ligne : en cas de conflit, elle prime.

## 18.1 Décisions d'implémentation

| # | Décision | Statut |
|---|---|---|
| 1 | Hébergement : **Vercel Functions + WebSocket (beta) + Redis Cloud** (intégration Marketplace `redis`) — voir §18.6 | acté |
| 2 | Mode **hybride** : le local (un seul écran) reste le défaut ; l'« en ligne » est une option activée par le MJ | acté |
| 3 | Le MJ reste **animateur** : pas de siège joueur en mode en ligne | acté |
| 4 | Reprise d'une partie en ligne : **terrain préparé** (identité reconnectable + projection au rejoin), non implémentée | acté |
| 5 | Le serveur reste un **dumb relay** : aucune logique ni validation métier | acté |

## 18.2 Terminologie — collision « session »

Deux sens coexistent dans le dépôt :

- **session Canap' QuiZZ** (`state.js`) : la « soirée » persistante (roster + sac de parties), enregistrée en IndexedDB, sans condition de fin ;
- **session réseau** (`WS.md`) : le salon WebSocket, qui ne vit que le temps d'une partie en ligne.

On nomme la seconde **room** ; son `sessionId` devient **`roomId`**. Une room correspond à **une partie** en ligne, pas à la session persistante.

L'URL de partage est `https://host/#join=<roomId>` (identifiant en **hash**, pas un chemin `/game/<roomId>`) : le front étant compilé en `base: './'` (assets relatifs), une route imbriquée casserait la résolution des assets (`/game/assets/*.css` introuvables → le fallback SPA renverrait du HTML).

## 18.3 Rôles et autorité

- **Host (MJ)** : créateur de la room, seul émetteur des messages d'état (`game.*`), source de vérité (`state.js`), **seul à appeler le LLM** — la clé API ne quitte jamais sa machine / son serveur.
- **Player** : joint via l'URL de partage, fournit `name` + `emoji`, reçoit une projection filtrée, n'émet que `lobby.join`, `lobby.leave`, `game.answer`, `game.answer.cancel`.

Le serveur étant un dumb relay, **le contrôle de rôle est appliqué côté host** : toute commande d'état (`game.start`, `game.reveal`, …) émise par un player est ignorée.

## 18.4 Projection de sécurité (règle d'or)

Le host ne broadcast jamais son état brut. Avant `reveal`, un player ne reçoit ni `answer`, ni `funnyOption`, ni `explanation`, ni les réponses des autres. Chaque `game.*` est une **vue calculée par rôle**. Le serveur ne peut pas garantir cela (il ne comprend pas le contenu) : c'est une responsabilité exclusive du host.

## 18.5 Messages métier (complète §5.2)

Enveloppe conservée : `{ type, payload, requestId, senderId }` (`senderId` ajouté par le serveur, jamais accepté du client).

Player → Host :

| type | payload | notes |
|---|---|---|
| `lobby.join` | `{ clientId, name, emoji }` | `clientId` persistant (localStorage) : identité stable, rejoin ; nom 1–18 chars, emoji ∈ liste |
| `lobby.leave` | `{}` | départ volontaire |
| `game.answer` | `{ optionKey }` | A/B/C/D, avant expiration du chrono |
| `game.answer.cancel` | `{}` | le joueur retire sa réponse |

Host → Players (filtrés, relayés) :

| type | payload | notes |
|---|---|---|
| `lobby.roster` | `{ players }` | `players` = `[{id,name,emoji,color,score}]`, diffusé à chaque join/leave |
| `lobby.join.rejected` | `{ targetId, reason }` | `reason` = `full` (complet), `taken` (nom/emoji pris), `started` (déjà lancée) |
| `game.start` | `{ settings }` | règles publiques, **sans config LLM** |
| `game.question` | `{ question, options[], difficulty, isBonus, deadline }` | **jamais** `answer`/`funnyOption`/`explanation` |
| `game.reveal` | `{ answer, answerText, funnyOption, funnyText, explanation, results[] }` | `answerText`/`funnyText` portent le libellé — le joueur n'a pas la question en cache au rejoin |
| `game.manche_end` | `{ winnerId, manchesTarget, players[] }` | |
| `game.victory` | `{ winnerId, players[] }` | |
| `game.state` | `{ targetId, question\|reveal\|mancheEnd\|victory\|waiting }` | projection ciblée au rejoin (§18.7) ; seul le joueur visé par `targetId` la traite |
| `room.closed` | `{}` | l'hôte a fermé la room (quitter la partie, terminer la session) |

## 18.6 Déploiement — décision : Vercel + Redis Cloud (beta)

Retenu : **Vercel Functions avec WebSocket (Public Beta) + Redis Cloud** (intégration Marketplace `redis`, le service Redis officiel). On reste ainsi 100 % Vercel, au prix de deux contraintes assumées :

- **instances serverless, éphémères et multiples** : une connexion WS est épinglée à une instance pour sa durée de vie (Fluid compute permet à une instance d'en porter plusieurs), mais deux clients d'une même room peuvent atterrir sur des instances différentes ;
- **état partagé hors instance** : la `Map` en mémoire du §3 devient **locale à chaque instance**. L'état de room et le relais inter-instances passent par **Redis Cloud**.

Architecture cible :

```text
client ──> Vercel Function (instance X) ──╮
                                          ├──> Redis Cloud
client ──> Vercel Function (instance Y) ──╯   · état des rooms (TTL)
                                               · pub/sub `room:<roomId>`
```

Règles :

1. `POST /api/sessions` écrit les métadonnées de room dans Redis avec un **TTL** (expiration 30 min sans activité / 4 h max, cf. §4).
2. Chaque instance s'abonne au canal `room:<roomId>` de ses connexions locales.
3. À la réception d'un message, l'instance publie sur `room:<roomId>` ; toutes les instances abonnées le renvoient à leurs sockets locaux de cette room.
4. La `Map` en mémoire ne sert qu'à retrouver les sockets **locaux** d'une instance ; la vérité de l'existence, de la limite et de l'expiration d'une room vit dans Redis.

Le dumb relay reste inchangé dans son principe (§17) : seule la localisation de l'état change. Le proxy LLM reste `api/gateway.js` (Vercel) / `vite.config.js` (dev) tel quel — la duplication « deux proxys » demeure, comme aujourd'hui.

**Provisionnement** : `vercel install redis` (alias `vc i redis`) crée la base **Redis Cloud** et injecte les variables de connexion dans le projet (URL `redis://`/`rediss://`, typiquement `REDIS_URL` — nom exact à confirmer au setup).

**Dépendances serveur** : ce choix introduit les premières dépendances npm runtime du dépôt — `ws` (WebSocket) et `ioredis` (client Redis standard) — utilisées **uniquement côté serveur**, jamais embarquées dans le bundle front (qui reste à zéro dépendance runtime).

## 18.7 Rejoin en pleine partie (implémenté)

Un joueur qui recharge en pleine partie rejoint avec le même `clientId` (persisté dans
`localStorage`). Le host reconnaît l'identité et **ré-associe la nouvelle connexion**
(`remapSender`) sans créer de doublon, puis renvoie la **projection d'état courante** via
`game.state { targetId, … }`, ciblée sur ce joueur (le relais relaie à tous, seul celui
visé par `targetId` la traite) :

- `question` — question sans réponse, options, chrono : le joueur reprend sa saisie ;
- `reveal` — révélation (réponse + textes + résultats). `answerText`/`funnyText` sont
  embarqués exprès : le joueur qui recharge n'a plus la question en cache ;
- `mancheEnd` / `victory` — fin de manche ou podium ;
- `waiting` — phase LOADING : la prochaine question arrivera d'elle-même.

La sortie du host (quitter la partie, terminer la session) ferme la room et diffuse
`room.closed` aux joueurs. Une partie en ligne n'est pas reprise après fermeture.

## 18.8 Chronomètre

Le host est seul maître du temps : il diffuse une **échéance absolue** (`deadline = Date.now() + durée`) dans `game.question` ; les players rendent le décompte **en local** vers cette échéance. Aucun tick réseau ; le verrouillage de saisie à expiration est appliqué côté host (comme aujourd'hui dans `game.js`).