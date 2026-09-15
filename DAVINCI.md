### Prompt de refonte UI/UX — **Canap’ QuiZZ**

```text
Tu es un expert senior en UI/UX, product design, design systems et intégration frontend Vanilla JS/CSS.

Ta mission est de réaliser une refonte visuelle et ergonomique complète de l’application **Canap’ QuiZZ**, sans casser ses fonctionnalités existantes et en respectant strictement la stack et les spécifications fournies.

---

# 1. Contexte produit

Canap’ QuiZZ est une application web de quiz multijoueur local, pensée pour être utilisée depuis un canapé, devant une TV, un projecteur ou un grand écran.

Le principe :

- 1 maître du jeu pilote l’application ;
- 2 à 6 joueurs répondent oralement ;
- le maître du jeu sélectionne les réponses au clavier ;
- les questions sont générées à la volée par un LLM ;
- chaque question contient 4 propositions ;
- une proposition est volontairement drôle, mais jamais correcte ;
- les parties se jouent localement, sur un seul écran partagé ;
- l’application est en français ;
- aucun compte utilisateur n’est nécessaire.

L’expérience recherchée :

> Une soirée quiz cool, conviviale, drôle et un peu compétitive, avec l’ambiance d’un jeu télé moderne joué depuis son canapé.

L’application doit être :

- très lisible à distance ;
- agréable le soir ;
- simple à comprendre immédiatement ;
- amusante sans être infantile ;
- premium sans devenir froide ;
- expressive et mémorable ;
- fluide sur desktop, tablette et mobile ;
- suffisamment spectaculaire pour donner envie de lancer “juste une dernière question”.

Le design doit avoir du caractère et “claquer”, mais la priorité reste toujours la clarté, l’ergonomie et la robustesse.

---

# 2. Sources de vérité

Tu dois utiliser les fichiers suivants comme références principales :

- `SPEC.md`
- `AGENTS.md`
- le code existant du projet
- les contrats d’état, de données et de rendu déjà présents

Important :

- `AGENTS.md` fait autorité lorsqu’il existe une différence avec `SPEC.md`.
- Ne modifie pas les contrats fonctionnels existants sans raison impérative.
- Ne remplace pas la stack.
- Ne transforme pas l’application en framework frontend.
- Ne crée pas de backend supplémentaire.
- Ne rends pas obligatoire une fonctionnalité qui n’est pas prévue dans le MVP.

Stack imposée :

- Vite ;
- Vanilla JavaScript ;
- HTML ;
- CSS ;
- LLM via provider OpenAI-compatible ;
- architecture existante dans `src/`.

---

# 3. Inventaire fonctionnel — ce qui existe et ne doit pas disparaître

**Lis cette section avant toute autre.** Le reste de ce document décrit surtout une
direction visuelle ; celle-ci décrit le produit tel qu’il est aujourd’hui. Une refonte
qui « oublie » un élément ci-dessous est une régression, pas un choix de design.

Vérifie chaque point **dans le code** avant de le déplacer, le fusionner ou le styler.

## 3.1. Hiérarchie de jeu : trois niveaux

```
session   roster de joueurs + sac de parties · AUCUNE condition de fin
  partie  best-of X manches, X impair (1, 3, 5, 7) · majorité des manches
          arrêt anticipé dès la majorité acquise
    manche course au `targetScore` (+ écart de 2 en option)
          scores RAZ à chaque manche, systématiquement
      question
```

Se tromper de niveau est l’erreur la plus coûteuse de ce projet. `targetScore` termine une
**manche**, pas la partie. L’interface doit rendre ces trois niveaux lisibles en
permanence : où en est la manche, où en est la partie, quelle session est ouverte.

## 3.2. Écrans et phases

Neuf phases, toutes montées par `main.js`. Une phase absente de `MOUNTERS` **ou** de
`UNMOUNTERS` donne un écran blanc sans erreur.

| Phase | Écran | Ce qui existe déjà |
|---|---|---|
| `HOME` | `home.js` | titre, promesse, plaque de session, menu, panneau de reprise, crédits, version |
| `SETUP` | `setup.js` | roster, thème, source Wikipédia, sélecteur de modes, règles, accordéon « Vacheries », parties interrompues, nom de session |
| `LOADING` | `game.js` | génération du lot de questions |
| `QUESTION` | `game.js` | question, chrono, 4 propositions, saisie par joueur |
| `REVEAL` | `game.js` | correction, option drôle, delta de points, explication |
| `MANCHE_END` | `game.js` | **fin de manche ≠ fin de partie** — écran distinct |
| `VICTORY` | `victory.js` | podium classé sur les **manches**, confettis, remise à zéro |
| `SESSIONS` | `sessions.js` | lister, créer, ouvrir, supprimer, parties par session |
| `SETTINGS` | `settings.js` | config LLM, partage par URL, reset d’usine |

## 3.3. Modes de jeu

Un **mode** est un jeu de règles nommé, stocké en IndexedDB. Cinq fournis, plus ceux que
le MJ crée. Le sélecteur est une rangée de cartes en tête du panneau de règles.

| Mode | Manches | Chrono | Pénalités | Public | Difficulté |
|---|---|---|---|---|---|
| 🍸 Canap’ éritif | 1 | — | — | Tout public | Facile |
| 🌙 Canap’ au lit | 1 | 1 min | — | Kid friendly | Facile |
| 🌶️ Canap’ épicé **(défaut)** | 1 | 1 min | mauvaise réponse −1 | Tout public | Équilibré |
| 🔞 Canap’ éro | 1 | 1 min | mauvaise réponse −1 | Adulte | Équilibré |
| 🔥 Canap’ ocalypse | 3 | 30 s | −1 / −2 en bonus, sans réponse −1 | Tout public | Difficile |

Comportements à préserver :

- sélectionner un mode recopie ses règles **dans le formulaire**, pas dans l’état ;
- **seules les règles sont recopiées** — le thème et l’article Wikipédia survivent, pour
  qu’on puisse durcir les règles sans reperdre l’article qu’on venait de chercher ;
- le badge « modifié » se **calcule** (`diffFromMode`), il ne se stocke pas : un drapeau
  mentirait dès qu’on remet une valeur à sa position d’origine ;
- actions contextuelles : enregistrer comme nouveau mode, mettre à jour, annuler les
  retouches, renommer, réinitialiser (mode fourni retouché), supprimer (mode perso) ;
- **un mode fourni ne se supprime pas** — le semis le recréerait au rechargement.

## 3.4. Règles de partie, et leur découpage

Le panneau de règles est **volontairement coupé en deux**. Ne le remets pas à plat.

**Visible** — difficulté, public, format de la partie (best-of), score cible, écart de 2 points.

**Accordéon « Vacheries », fermé au montage** — questions bonus ×2, chronomètre et sa durée,
−1 sans réponse, mode punisher et sa sévérité, mort subite et son seuil.

Deux invariants non négociables :

- l’accordéon reste **dans** `.settings-panel`. Les écouteurs du badge « modifié » y sont
  délégués : l’en sortir les couperait **sans la moindre erreur** ;
- une **pastille compte les options actives** sur le résumé. C’est le seul indice que des
  règles tournent derrière un volet fermé — choisir Canap’ ocalypse change chrono,
  pénalités et mort subite sans rien déplier. Ne la retire pas sans ouvrir l’accordéon.

## 3.5. Mort subite

Au seuil de fautes (1/2/3/5), le joueur est **exclu de la manche**, pas de la partie : il
revient à la manche suivante. Une absence de réponse compte comme une faute.

Un exclu ne gagne ni ne perd plus rien, et ne compte plus dans les statistiques. Sa ligne
de saisie est verrouillée. L’interface doit rendre cet état **évident sans dépendre de la
couleur** — l’implémentation actuelle ajoute un suffixe ☠ au jeton du joueur.

## 3.6. Reprise d’une partie interrompue

Quitter une partie en cours écrit un instantané en IndexedDB. Le panneau « Parties
interrompues » le propose **sur l’accueil et dans les réglages**, avec pour chaque entrée :
la manche en cours, les joueurs avec leur score, l’horodatage, et les actions
reprendre / supprimer.

**Ce panneau est masqué quand la liste est vide.** Ce point a demandé plusieurs correctifs,
ne le casse pas en le stylant.

## 3.7. Source des questions

Trois sources, dans cet ordre de priorité : **article Wikipédia > thème libre > thèmes
prédéfinis**. Le mode article propose une recherche intégrée, accepte une URL collée, et
consomme l’article par fenêtre glissante de sections. L’interface doit montrer l’article
retenu et permettre de le retirer.

## 3.8. Réglages globaux de l’appareil

L’écran `SETTINGS` est distinct des réglages de partie. Il porte la configuration LLM
(globale à l’appareil, **hors de `settings`**), le partage de configuration par URL, et le
**reset d’usine**.

Le reset vide l’archive puis `localStorage`, et recharge **immédiatement** — sans rien
entre les deux. Les **modes de jeu sont conservés**. L’ordre est à sécurité intégrée : si
l’archive résiste, on s’arrête avant de toucher à `localStorage`.

## 3.9. Éléments d’écran à ne pas perdre

- le **jeton de joueur** (`components/playerChip.js`) : emoji + info-bulle de nom, partagé
  par trois écrans. Il émet **déjà** son `data-tooltip` et son `aria-label` — lui en passer
  un second produit un attribut dupliqué, ignoré en silence ;
- les **crédits** et le **numéro de version** en pied d’accueil. La version est le seul
  moyen de savoir quel commit tourne quand un bug est signalé ;
- le **nom de session éditable** sur l’écran de réglages ;
- les **toasts** (`qc:toast`), affichés par `main.js` dans `#toast-region`.

---
# 4. Objectif de la refonte

Refondre l’interface de Canap’ QuiZZ afin d’obtenir une expérience visuelle cohérente, moderne, chaleureuse et ludique, tout en respectant les fonctionnalités déjà implémentées.

La refonte doit principalement améliorer :

- la hiérarchie visuelle ;
- la lisibilité ;
- la compréhension des étapes ;
- la sensation de jeu ;
- la visibilité des actions principales ;
- la gestion des thèmes ;
- la cohérence des composants ;
- l’expérience sur grand écran ;
- la responsivité ;
- l’accessibilité ;
- les états de chargement, d’erreur et de victoire.

Ne te contente pas d’ajouter des couleurs ou des ombres. Revois la composition, les espacements, les proportions, les interactions et la hiérarchie de chaque écran.

---

# 5. Direction artistique

Crée une direction artistique autour de ces notions :

- soirée canapé ;
- quiz télévisé ;
- arcade moderne ;
- humour léger ;
- compétition conviviale ;
- néons doux ;
- cartes de jeu ;
- stickers et badges ;
- énergie positive ;
- confort visuel.

L’identité doit être reconnaissable, mais éviter les clichés d’un simple dashboard SaaS.

## Ambiance visuelle souhaitée

L’interface peut évoquer :

- un plateau de jeu moderne ;
- une émission de quiz décontractée ;
- une console de jeu familiale ;
- une soirée entre amis ;
- des cartes colorées posées sur une table ;
- des néons dans une pièce sombre.

Le résultat doit être fun, mais pas enfantin.

## À éviter

Évite absolument :

- l’interface froide de logiciel professionnel ;
- le dashboard rempli de petits widgets ;
- les textes trop petits ;
- les layouts trop denses ;
- le noir pur partout ;
- les néons agressifs ;
- les couleurs utilisées sans hiérarchie ;
- les animations permanentes ;
- les effets qui gênent la lecture ;
- les éléments cliquables qui ressemblent à du texte ;
- les composants génériques sans personnalité ;
- les interactions nécessitant une précision excessive.

---

# 6. Système de couleurs et thèmes

Le projet possède déjà un système de thèmes basé sur :

```html
data-color-theme
```

et le fichier :

```text
src/styles/theme.css
```

Respecte et améliore ce mécanisme au lieu d’en créer un second.

Le projet compte **10 thèmes nommés**, pas un couple sombre/clair : VS Code, Matrix,
Girly, Windows 98, Jungle, Kids Friendly, Apple, Apple Glass, Bubble Island et
**Paper Quest, qui est le thème par défaut et qui est clair**. Ne les fusionne pas en
deux variantes : chacun est une identité à part entière, menus compris, et porte sa
propre `--font-display`.

Ajouter un thème = une entrée dans `COLOR_THEMES` + un bloc de surcharges dans
`theme.css`. Aucun autre fichier à toucher : si ta refonte impose d'éditer un écran
pour ajouter un thème, c'est que le découpage est cassé.

Le système doit inclure :

- les 10 thèmes existants, tous préservés ;
- des variantes lisibles de jour comme de nuit selon le thème choisi ;
- des variables CSS centralisées ;
- des couleurs sémantiques ;
- des états visuels cohérents ;
- des contrastes suffisants ;
- des transitions douces entre thèmes.

Le thème sombre doit être adapté à une utilisation le soir. N’utilise pas uniquement un fond noir et du texte blanc : crée une hiérarchie de surfaces avec :

- fond général ;
- surface principale ;
- surface élevée ;
- surface secondaire ;
- overlays ;
- bordures ;
- couleurs d’accent ;
- couleurs de feedback.

Conserve les variables déjà définies lorsque cela est pertinent, notamment :

```css
--bg-void
--bg-surface
--bg-surface-raised
--bg-surface-soft
--color-accent-primary
--color-accent-cyan
--color-accent-pink
--color-accent-lime
--color-success
--color-error
--color-warning
--color-text
--color-muted
--color-border
--color-overlay
```

Tu peux ajuster leurs valeurs si cela améliore l’ensemble, mais évite de casser les usages existants.

---

# 7. Design system à construire ou renforcer

Renforce le design system existant dans :

```text
src/styles/theme.css
src/styles/layout.css
src/styles/components.css
src/styles/arcade.css
```

Le système doit définir clairement :

- couleurs ;
- typographies ;
- tailles de texte ;
- espacements ;
- largeurs maximales ;
- rayons ;
- ombres ;
- halos ;
- transitions ;
- états interactifs ;
- breakpoints ;
- surfaces ;
- composants de formulaire ;
- composants de jeu.

## Composants à harmoniser

Prévois notamment :

- boutons principaux ;
- boutons secondaires ;
- boutons d’action critique ;
- cartes ;
- panneaux ;
- badges ;
- chips de joueurs ;
- avatars ;
- champs texte ;
- sliders ;
- interrupteurs ;
- boutons radio ;
- options de réponse ;
- modales ;
- toasts ;
- barres de progression ;
- chronomètres ;
- classements ;
- podium ;
- indicateurs de score ;
- messages d’erreur ;
- états de chargement ;
- états vides.

Chaque composant doit posséder des états explicites :

- normal ;
- hover ;
- focus ;
- active ;
- disabled ;
- selected ;
- success ;
- error ;
- loading.

Tous les composants importants doivent être réutilisables et cohérents entre les écrans.

---

# 8. Écran d’accueil

Fichier concerné :

```text
src/screens/home.js
```

L’écran d’accueil doit immédiatement expliquer l’expérience.

Il doit mettre en avant :

- le titre exact `Canap' QuiZZ` — casse comprise, apostrophe droite ;
- la promesse : le savoir, la mauvaise foi, le canapé ;
- l’action principale pour commencer une partie ;
- la reprise d’une session si elle existe ;
- l’accès aux sessions ;
- l’accès aux réglages ;
- une présentation courte du mode de jeu.

L’accueil doit donner une impression de jeu dès le premier regard.

Prévoir une hiérarchie claire :

1. titre ;
2. promesse ;
3. bouton principal ;
4. actions secondaires ;
5. éventuelles sessions récentes.

Ne surcharge pas l’écran.

---

# 9. Écran SETUP

Fichier concerné :

```text
src/screens/setup.js
```

L’écran SETUP est central. Il doit être entièrement repensé visuellement, tout en respectant son contrat fonctionnel.

La structure fonctionnelle existante comprend :

- les joueurs ;
- le thème ;
- les règles ;
- le démarrage ;
- la validation ;
- les éventuelles sources Wikipédia ;
- les modes de jeu prévus par le projet.

Respecte notamment :

- le **sélecteur de modes** en tête du panneau de règles ;
- l’**accordéon « Vacheries »**, fermé au montage, avec sa pastille de comptage ;
- le panneau **« Parties interrompues »**, masqué quand la liste est vide ;
- le champ **nom de session**, éditable, hors du `<form>` (`Entrée` n’y lance pas la partie) ;
- la **recherche d’article Wikipédia** et l’article retenu ;
- 2 joueurs affichés par défaut ;
- maximum 6 joueurs ;
- suppression possible à partir de 3 joueurs ;
- prénoms obligatoires ;
- prénoms uniques sans tenir compte de la casse ;
- longueur de 1 à 18 caractères ;
- sélection d’emoji ;
- couleurs automatiques distinctes ;
- 8 thèmes prédéfinis ;
- thème libre ;
- score cible de 5 à 30 ;
- option écart de 2 points ;
- option questions bonus ;
- validation avant démarrage.

## Mise en page recommandée

Sur desktop :

- grande composition en deux colonnes ou en grille ;
- joueurs et thème bien visibles ;
- règles regroupées dans un panneau clair ;
- bouton de démarrage toujours identifiable ;
- zones respirantes adaptées à un grand écran.

Sur mobile :

- empilement logique ;
- sections repliables si nécessaire ;
- bouton de démarrage accessible ;
- champs confortables ;
- aucun contenu horizontalement coupé.

Le bouton de démarrage doit être le CTA dominant de l’écran.

Les erreurs doivent être visibles, compréhensibles et placées près du champ concerné.

---

# 10. Gestion des joueurs

Les cartes joueur doivent être plus chaleureuses et plus lisibles.

Chaque carte doit afficher clairement :

- le numéro du joueur ;
- l’emoji ;
- le prénom ;
- la couleur associée ;
- l’ouverture de la grille d’avatars (voir ci-dessous) ;
- l’action de suppression lorsque disponible.

Les couleurs servent à identifier les joueurs, mais ne doivent jamais être l’unique moyen de transmettre une information.

Les contrôles doivent être utilisables :

- au clavier ;
- avec un lecteur d’écran ;
- sur écran tactile ;
- à distance raisonnable sur un grand écran.

Les boutons iconographiques doivent garder leurs labels accessibles, par exemple :

```html
aria-label="Choisir l'emoji de Alice"
```

## La grille d’avatars existe déjà — ne la remplace pas par un bouton de défilement

Cliquer sur l’avatar ouvre une grille des **30 emoji** de `PLAYER_EMOJIS`. Cette grille
a été construite pour résoudre des problèmes précis ; les reproduire est obligatoire :

- elle est une **rangée pleine largeur dans la grille de la carte** (`grid-column: 1 / -1`),
  pas un flottant positionné : pas de `z-index` à arbitrer entre les dix thèmes, rien qui
  déborde d’un conteneur à `overflow` caché ;
- les avatars **pris par un autre joueur sont `disabled`, pas masqués** — on comprend
  pourquoi ils sont hors d’atteinte ;
- fermeture par `Échap` **et** par clic à l’extérieur ;
- le focus part sur la première case libre à l’ouverture et **revient au déclencheur** à la
  fermeture, la grille ayant quitté le document ;
- chaque case porte son nom français (`PLAYER_EMOJI_LABELS`) : sans lui, un lecteur d’écran
  annonce « bouton » trente fois.

Les 30 avatars ont été choisis pour leur contraste à 24 px sur les dix thèmes. Les pastels
(panda, koala, licorne) ont été écartés : leur contour se dissout sur les thèmes clairs.
Tous sont en **un seul point de code** — pas de séquence ZWJ, la comparaison stricte de
`nextEmoji()` en dépend. N’en ajoute aucun sans vérifier ces deux propriétés.

---

# 11. Gestion des thèmes de quiz

Les thèmes prédéfinis doivent être présentés comme des choix visuels agréables :

- cartes ou boutons radio stylisés ;
- icône ou accent visuel ;
- état sélectionné très évident ;
- texte lisible ;
- navigation clavier correcte.

Les thèmes existants sont :

- Culture générale ;
- Cinéma & séries ;
- Musique ;
- Sciences & nature ;
- Histoire ;
- Sport ;
- Gastronomie ;
- Jeux vidéo.

Le thème libre doit être visuellement distingué, sans être isolé de manière confuse.

Lorsqu’un utilisateur écrit dans le champ libre, l’état “Thème libre” doit être clairement sélectionné.

---

# 12. Écran de jeu

Fichier concerné :

```text
src/screens/game.js
```

L’écran de jeu est prioritaire.

Il doit fonctionner aussi bien :

- sur un laptop ;
- sur un grand écran ;
- sur une TV ;
- sur un projecteur ;
- sur mobile ou petite largeur.

La question doit être le point focal absolu de l’écran.

La hiérarchie recommandée :

1. thème et progression ;
2. question ;
3. chronomètre ;
4. propositions A/B/C/D ;
5. joueurs et saisie des réponses ;
6. score ou classement compact ;
7. action révéler.

La question doit être lisible depuis un canapé.

Les options doivent être :

- grandes ;
- clairement différenciées ;
- facilement cliquables ;
- identifiables par leur lettre ;
- animées avec modération ;
- accessibles au clavier ;
- compréhensibles sans dépendre uniquement de la couleur.

## Raccourcis clavier existants

Ils sont posés sur `document` dans `game.js` et **doivent rester fonctionnels** :

| Touche | Effet |
|---|---|
| `1` `2` `3` `4` | sélectionne la proposition A / B / C / D |
| `Échap` | quitter la partie (avec confirmation) |

Un écouteur sur `document` se double facilement lors d'un redessin : il est enregistré
avec l'`AbortController` de l'écran, ne casse pas ce câblage.

---

# 13. Phase de révélation

La phase `REVEAL` doit produire un moment de feedback satisfaisant.

Après révélation :

- désactiver les boutons de saisie ;
- afficher la bonne réponse ;
- afficher clairement l’option drôle ;
- distinguer les autres réponses ;
- afficher le choix de chaque joueur ;
- afficher ✓, ✕ ou — ;
- afficher le delta de points ;
- afficher l’explication ;
- mettre à jour le classement ;
- mettre en évidence le leader ;
- afficher l’action suivante.

Utilise à la fois :

- couleur ;
- texte ;
- icône ;
- badge ;
- animation courte.

Exemples de libellés :

- `Correct`
- `Incorrect`
- `Pas de réponse`
- `Option drôle`
- `+1`
- `+2`
- `+0`

Ne fais jamais reposer la compréhension uniquement sur la couleur.

---

# 14. Écran VICTORY

Fichier concerné :

```text
src/screens/victory.js
```

L’écran de victoire doit être le point culminant de la partie.

**Attention au modèle de victoire.** `VICTORY` marque la fin d’une **partie**, remportée à
la **majorité des manches** (`computePartieWinner`), pas en atteignant le score cible — ce
dernier ne termine qu’une *manche* (`hasMancheWinner`). Le podium est classé sur les
**manches gagnées**, pas sur les points. Confondre les deux niveaux est l’erreur la plus
coûteuse de ce projet.

Il doit afficher :

- le gagnant de la partie ;
- son emoji ;
- les manches remportées, et le nombre nécessaire ;
- le détail par manche ;
- le podium, classé sur les manches ;
- le classement ;
- les égalités éventuelles ;
- le thème ;
- le nombre de questions ;
- le nombre de bonnes réponses ;
- la durée approximative si disponible ;
- les actions de rejouer ;
- les actions de modification des réglages ;
- l’effacement des données locales avec confirmation.

Le podium doit être visuellement fort, mais rester lisible.

Le gagnant doit être immédiatement identifiable.

Les confettis existants doivent être conservés et améliorés si nécessaire, tout en respectant :

```css
prefers-reduced-motion: reduce
```

Ne surcharge pas l’écran avec des animations permanentes.

---

# 15. Sessions, archive et reprise

Le projet utilise IndexedDB pour les sessions, parties et reprises.

Respecte les fonctionnalités existantes liées à :

```text
src/db.js
src/screens/sessions.js
```

L’interface des sessions doit permettre de comprendre rapidement :

- quelles parties existent ;
- quelle session peut être reprise ;
- quelle partie est terminée ;
- quelle partie est en cours ;
- la date ou l’ordre de dernière utilisation ;
- le thème ;
- les joueurs ;
- le score ou le statut.

Les actions destructives doivent être clairement identifiées et confirmées.

Ne supprime jamais une session sans confirmation explicite.

---

# 16. Réglages

Fichier concerné :

```text
src/screens/settings.js
```

Les réglages doivent être accessibles, mais ne doivent pas voler la priorité au lancement d’une partie.

Présente clairement :

- les réglages visuels ;
- le thème de couleurs ;
- les réglages LLM ;
- les éventuels paramètres de source ;
- les actions de nettoyage des données locales.

Les réglages sensibles doivent être expliqués simplement.

Ne fais apparaître une clé API nulle part où elle ne figure pas déjà.

**Deux exceptions délibérées, à ne pas « corriger » :**

1. le champ `#llm-api-key` est un `type="password"` du formulaire BYOK ;
2. le **lien de partage de configuration** contient la clé **en clair** et l’affiche dans un
   champ en lecture seule. C’est assumé et signalé à l’utilisateur par un avertissement
   explicite : base64url est un encodage, pas un chiffrement. L’URL est nettoyée par
   `history.replaceState` dès son import. Ne supprime ni la fonctionnalité, ni
   l’avertissement qui l’accompagne.

---

# 17. Responsive design

L’expérience doit être conçue pour trois contextes :

## Grand écran / TV

- texte très lisible ;
- zones d’action larges ;
- contraste élevé ;
- hiérarchie immédiate ;
- information importante visible à plusieurs mètres ;
- pas de dépendance à des détails minuscules ;
- composition immersive.

## Desktop

- espace généreux ;
- bonne utilisation de la largeur ;
- panneaux équilibrés ;
- navigation naturelle ;
- pas de longues colonnes inutiles.

## Mobile

- largeur minimale de 320 px ;
- aucune coupure horizontale ;
- cibles tactiles d’au moins 44 × 44 px ;
- espacement d’au moins 8 px ;
- boutons faciles à atteindre ;
- contenus réorganisés intelligemment ;
- texte lisible à 200 % de zoom.

Ne te contente pas de réduire les tailles. Recompose les layouts lorsque nécessaire.

---

# 18. Accessibilité obligatoire

Respecte les exigences déjà présentes dans la spécification :

- toute action est un bouton ou un contrôle natif ;
- aucune interaction basée uniquement sur un `div` cliquable ;
- **focus visible** : `SPEC.md` §13.6 prescrit `outline: 3px solid var(--color-accent-cyan)`,
  mais le code applique `outline: 1px solid var(--color-accent-primary); outline-offset: -1px`
  (`theme.css`). C'est une divergence réelle, pas un oubli de ta part : tranche-la
  explicitement dans ton analyse au lieu de la propager. Quel que soit ton choix, le focus
  doit rester visible sur les **dix** thèmes — un outline cyan disparaît sur Paper Quest ;
- labels associés aux inputs ;
- `aria-label` sur les boutons iconographiques ;
- `aria-live="polite"` pour les scores et informations dynamiques ;
- `role="alert"` pour les erreurs bloquantes ;
- contraste suffisant ;
- navigation clavier complète ;
- prise en charge du zoom à 200 % ;
- largeur de 320 px ;
- prise en compte de `prefers-reduced-motion`.

Le design doit rester compréhensible sans percevoir les couleurs.

---

# 19. Animations et micro-interactions

Ajoute des animations courtes et utiles pour :

- sélection d’une carte ;
- changement de thème ;
- apparition d’une question ;
- sélection d’une réponse ;
- révélation ;
- gain de points ;
- mise à jour du leader ;
- passage à la question suivante ;
- victoire ;
- affichage d’un toast.

Les animations doivent :

- être rapides ;
- renforcer le feedback ;
- ne pas bloquer le joueur ;
- être désactivables ou réduites ;
- respecter `prefers-reduced-motion`.

Évite :

- les animations longues ;
- les déplacements excessifs ;
- les effets qui attirent l’attention loin de la question ;
- les animations simultanées trop nombreuses.

---

# 20. Contraintes techniques

Respecte l’architecture existante :

```text
src/main.js
src/state.js
src/api.js
src/prompt.js
src/storage.js
src/db.js
src/modes.js
src/wikipedia.js
src/shareConfig.js
src/themeSwitcher.js
src/confetti.js
src/validation.js
src/constants.js
src/components/
src/screens/
src/styles/
```

Priorité aux modifications CSS et aux améliorations de structure HTML.

Modifie le JavaScript uniquement lorsque cela est nécessaire pour :

- améliorer l’accessibilité ;
- ajouter un état visuel manquant ;
- corriger une interaction ;
- préserver la cohérence du rendu ;
- gérer correctement le responsive ;
- éviter un comportement cassé.

## Invariants qui cassent en silence

Chacun de ces points a coûté un correctif. Aucun ne produit d’erreur visible quand il est
violé — c’est précisément pourquoi ils sont listés ici.

| Invariant | Ce qui arrive si tu le casses |
|---|---|
| `[hidden] { display: none !important; }` dans `layout.css` | `[hidden]` vient de la feuille **navigateur** : toute règle **auteur** posant `display` la bat à spécificité égale. Cinq panneaux restaient affichés à vide. N’ajoute aucun `display: … !important` concurrent. |
| Les écouteurs délégués sur `.settings-panel` | Sortir une règle du conteneur coupe le badge « modifié » sans erreur. |
| `padding ≥ border-image-width` | `border-image` ne réserve pas d’espace : le cadre 9-slice recouvre le texte. |
| `arcade.css` ne contient **aucune** couleur en dur | Il n’en contient plus une seule. Y réintroduire une couleur re-fige l’identité d’un thème sur tous les autres. |
| Le chrono ne passe **jamais** par `dispatch()` | L’abonné de `main.js` écrit dans `localStorage` à chaque dispatch : un tick par seconde = deux écritures par seconde. Le décompte vit en local et vise une **échéance**, pas un compteur décrémenté. |
| `db.js` avale ses erreurs | L’archive est un confort, pas une dépendance : la navigation privée doit laisser jouer. Ne transforme pas ces `catch` en erreurs d’UI. |
| `playerChip` émet déjà `data-tooltip` et `aria-label` | Un attribut dupliqué est ignoré en silence par le parseur. |
| Les avatars sont en un seul point de code | Une séquence ZWJ casse la comparaison stricte de `nextEmoji()`. |

Ne modifie pas :

- le contrat `Question` ;
- le système de scoring ;
- les règles de validation ;
- les appels LLM ;
- la logique IndexedDB ;
- la hiérarchie des phases ;
- les raccourcis clavier ;
- la persistance existante ;
- la hiérarchie session / partie / manche ;
- les règles de fin de manche en mort subite ;
- le semis versionné des modes de jeu ;
- `DB_VERSION` et les migrations IndexedDB ;

sauf si le code actuel viole explicitement la spécification ou `AGENTS.md`.

**`DB_VERSION` vaut 4.** Les migrations sont le seul endroit du projet où une erreur est à
la fois silencieuse et destructive. N’y touche pas pour des raisons de présentation.

`__APP_VERSION__` et `__REQUIRE_LLM_CONFIG__` sont injectés par `define` à la compilation.
Ce ne sont pas des variables d’exécution : ne tente pas de les lire depuis `window`.

---

# 21. Méthode de travail attendue

Avant de modifier le code :

1. Analyse la structure actuelle du projet.
2. Lis `AGENTS.md`.
3. Identifie les composants et styles déjà présents.
4. Compare l’implémentation avec `SPEC.md`.
5. Liste les incohérences UI/UX.
6. Définis une direction visuelle cohérente.
7. Propose un plan de modification par fichier.

Ensuite :

1. Mets à jour le design system.
2. Harmonise les layouts globaux.
3. Revois l’accueil.
4. Revois SETUP.
5. Revois l’écran de jeu.
6. Revois la révélation.
7. Revois la victoire.
8. Revois les sessions et réglages.
9. Teste les thèmes.
10. Teste les breakpoints.
11. Teste le clavier et les états d’accessibilité.
12. Vérifie qu’aucune fonctionnalité n’a régressé.

## Comment vérifier, concrètement

Il n’y a **pas de framework de test** dans ce projet. La suite existante consiste en
scripts Node qui importent les modules avec `localStorage`, `navigator` et `indexedDB`
bouchonnés. Plus de 500 assertions couvrent l’état, les modes, la mort subite, le reset et
la cohérence de la documentation. **Fais-les tourner avant et après.**

Trois pièges de vérification, tous rencontrés sur ce projet :

- **Contrôle le code de retour de `npm run build`, jamais ses dernières lignes.** Une erreur
  de bundling y affiche une trace de pile, pas un résumé : un `tail` donne l’illusion d’un
  succès. Vite compile sans broncher du JS dont une fonction appelée n’existe pas — croise
  les fonctions appelées avec celles définies ou importées.
- **Le bouchon IndexedDB doit donner un `Map` PAR store**, chacun avec son `keyPath`
  (`sessions`/`parties`/`modes` → `id`, `resume` → `partieId`). Un bouchon qui les écrase
  dans une seule `Map` fait passer un test pour de mauvaises raisons.
- **Vérifie que chaque `var(--token)` que tu écris existe.** Un jeton inventé rend la
  déclaration invalide *silencieusement* : le fond disparaît, l’état sélectionné ne se
  distingue plus, et rien n’est signalé. C’est déjà arrivé sur quatre jetons.

Enfin : **le patch de `package.json` s’incrémente tout seul** à chaque commit sur `dev`
(hook `pre-commit`). Ne t’étonne pas de le voir bouger, et ne le modifie pas à la main.

---

# 22. Résultat attendu

Le résultat final doit donner l’impression d’un vrai produit fini, pas d’une simple interface technique.

Canap’ QuiZZ doit évoquer :

- une soirée réussie ;
- une compétition bon enfant ;
- une app qu’on a envie de montrer ;
- une expérience qui fonctionne immédiatement ;
- un jeu qui donne envie de rejouer.

Le design doit être suffisamment expressif pour faire dire :

> “Ah ouais, ça claque.”

Mais suffisamment clair pour que quelqu’un puisse lancer une partie sans explication.

Commence par fournir :

1. ton analyse de l’interface existante ;
2. les problèmes UX prioritaires ;
3. la direction artistique proposée ;
4. le plan de refonte par fichier ;
5. les changements de design system ;
6. puis seulement l’implémentation.
```