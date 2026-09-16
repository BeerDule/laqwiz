# Paper Quest — spécification d'implémentation

> Destinataire : une IA qui a le même dépôt (`quizz-canape`) mais pas cette version du thème.
> Objectif : reproduire à l'identique le thème **Paper Quest** (`data-color-theme="paper"`),
> **avec toutes les longueurs exprimées en `em`, sur une taille de police de base de 22 px.**

---

## 0. Conventions à lire avant tout

### 0.1 Unités

- **Base : `1em = 22px`.** Toute longueur de ce document a été convertie avec `em = px / 22`,
  arrondie à 4 décimales. La valeur d'origine en px est rappelée en commentaire (`/* 18px */`)
  pour qu'on puisse la vérifier.
- **Restent tels quels** (ce ne sont pas des longueurs) :
  - `border-image-slice` : c'est un nombre de **pixels du sprite source**, sans unité. `110`, `60`, `0 40`
    ne doivent **jamais** être convertis ;
  - les pourcentages, les `vw`, les durées (`ms`), les opacités, les couleurs, les angles, les
    courbes `cubic-bezier`, les coefficients (`--motion-pop`).
- Dans un `clamp()`, seules les bornes en px deviennent des em ; le terme en `vw` reste.

### 0.2 Le piège de l'em : il suit la police de l'élément, pas la racine

`em` se calcule sur la `font-size` **de l'élément lui-même** (et, pour `font-size`, sur celle du parent).
Les valeurs ci-dessous supposent un contexte à 22 px. Là où l'élément a une autre taille, la longueur
grandit ou rétrécit avec lui. Voici les cas connus du dépôt, et quoi faire :

| Élément | `font-size` actuelle | Conséquence | Consigne |
|---|---|---|---|
| `.arcade-btn--icon` | **mis à `0`** par le thème | `width: 2.4545em` vaut **0** | Ne pas masquer le texte par `font-size: 0`. Garder la taille de base et masquer le glyphe par `color: transparent` (le glyphe est `‹`, une vraie encre, donc ça marche). |
| `.player-card__remove` | **mis à `0`** par le thème | largeur/hauteur héritées en em valent **0** | Même consigne : `color: transparent` au lieu de `font-size: 0` (le glyphe est `✕`). |
| `.arcade-btn`, `#btn-start`, `#btn-reveal` | `--text-menu` / `--text-menu-lg` (19–32 px) | les bouts de plaque (`border-image-width`) et les `::before` grandissent avec le libellé | Voulu : la plaque suit son texte. Ne rien corriger. |
| `.badge`, `.leaderboard-mini__item`, `.mode-card__name` | `--text-meta` (≈13 px) | une icône `::before` de `.6818em` y ferait ~9 px | Recalculer ces icônes sur la taille de l'hôte (valeurs données en §5 dans la colonne « hôte »), ou forcer `font-size: 1rem` sur le pseudo-élément. |
| `.timer`, `.answer-delta` | `--text-option` | la bordure 2 px devient un peu plus épaisse | Tolérable. Si on veut un trait constant, utiliser `.0909rem`. |

**Règle générale :** si le résultat visuel doit rester en « pixels à 22 px » quel que soit l'hôte,
utiliser `rem` avec une racine à 22 px. Sinon, `em` et accepter la mise à l'échelle.

### 0.3 Table de conversion utilisée

| px | em | | px | em | | px | em |
|---|---|---|---|---|---|---|---|
| 1 | .0455 | | 12 | .5455 | | 24 | 1.0909 |
| 2 | .0909 | | 13 | .5909 | | 26 | 1.1818 |
| 3 | .1364 | | 14 | .6364 | | 28 | 1.2727 |
| 4 | .1818 | | 15 | .6818 | | 30 | 1.3636 |
| 5 | .2273 | | 16 | .7273 | | 32 | 1.4545 |
| 6 | .2727 | | 18 | .8182 | | 40 | 1.8182 |
| 8 | .3636 | | 19 | .8636 | | 54 | 2.4545 |
| 10 | .4545 | | 20 | .9091 | | 96 | 4.3636 |
| | | | 21 | .9545 | | 140 | 6.3636 |

---

## 1. Identité du thème

**Intention :** une table de jeu. Du parchemin et des feuilles de papier froissé posés sur des planches,
sous une lumière de bougie qui laisse les coins dans l'ombre. Tout est **cerné d'un trait sombre**
(`#560e12`), comme les sprites du kit. Les ombres portées sont **franches et sans flou**. Le papier
**claque** sur la table (arrivée courte avec un léger rebond).

- Thème **clair** (`color-scheme: light`).
- C'est le **thème par défaut** de l'application.
- Palette échantillonnée sur les sprites : parchemin `#f8c8a8` cerné de `#560e12`, papier `#f8f8e8`,
  bandeaux orange / olive / rouge / bleu.

---

## 2. Câblage

### 2.1 Activation

- Le thème s'active par l'attribut `data-color-theme="paper"` sur `<html>`
  (`document.documentElement.dataset.colorTheme`), posé par [src/themeSwitcher.js](src/themeSwitcher.js).
- Enregistrement dans [src/constants.js](src/constants.js) :

```js
export const COLOR_THEMES = {
  // … autres thèmes …
  paper:   { label: 'Paper Quest' },
};
export const DEFAULT_COLOR_THEME = 'paper';
```

- Toutes les règles vivent dans [src/styles/theme.css](src/styles/theme.css), préfixées par
  `[data-color-theme="paper"]`. **Aucun sprite ni couleur en dur** dans `arcade.css`, `stage.css`
  ou `components.css` : ces fichiers ne consomment que des jetons.

### 2.2 Calques de scène

`index.html` doit contenir, hors de `#app` (les écrans remplacent `#app.innerHTML`) :

```html
<div id="stage-backdrop" aria-hidden="true"></div>
<div id="stage-vignette" aria-hidden="true"></div>
<main id="app" aria-live="polite"></main>
```

`stage.css` les peint en `position: fixed; inset: 0; pointer-events: none;`, `z-index: -2` pour le
fond (`background-image: var(--stage-backdrop)`) et `-1` pour la vignette
(`background-image: var(--stage-vignette)`).

### 2.3 Polices

| Rôle | Police | Fichier | Remarque |
|---|---|---|---|
| Texte courant **et** titres h1/h2 (`--font-display`) | Mukta 400/500/600/700 | `public/fonts/mukta-*-latin.woff2` | Paper Quest met `--font-display: var(--font-sans)`. |
| Tous les `<button>` (`--font-button`) | Nerko One 400 | `public/fonts/nerko-one-latin.woff2` | N'existe qu'en 400. Le `font-weight: 700` des boutons produit un **gras synthétique volontaire** (voir §7). |
| Titre des menus (`.arcade__title h1`, `.arcade__bar h1`) | Irish Grover 400 | `public/fonts/irish-grover-latin.woff2` | Déclarée dans `arcade.css`, appliquée **uniquement** dans le bloc Paper Quest. |

Toutes les polices sont hébergées localement (`font-display: swap`, sous-ensemble latin).

### 2.4 Inventaire des sprites (`public/paper-ui/`)

Dimensions en pixels **du fichier source** (utiles pour `border-image-slice`, qui ne se convertit pas).

| Fichier | Taille | Usage | Où |
|---|---|---|---|
| `bar-a.png` | 685×192 | plaque **orange** | `.arcade-btn--primary`, `#btn-start`, `#btn-reveal`, remplissage du rail du **meneur** |
| `bar-b.png` | 685×192 | plaque par défaut | `.arcade-btn` |
| `bar-c.png` | 685×192 | plaque **rouge** | `.arcade-btn--danger` |
| `bar-d.png` | 685×192 | plaque **bleue** | remplissage du rail de score |
| `bar-e.png` | 685×192 | plaque **terne** | `.arcade-btn:disabled` |
| `frame.png` | 507×406 | parchemin lacé (9-slice) | `.arcade-plaque`, `.arcade-card`, `.panel`, `.podium--steps .podium__row` |
| `paper.png` | 482×380 | feuille froissée (bord seul) | `.question-card`, `.answer-card` |
| `coin.png` | 248×242 | pièce | `.answer-card__score::before`, `.answer-delta--plus::before` |
| `star-gold.png` | 197×215 | étoile pleine | `.badge--bonus::before`, 3ᵉ marche du podium, `.manche-pip--won`, carte/mode actifs |
| `star-silver.png` | 197×215 | étoile terne | 2ᵉ marche du podium, `.manche-pip` |
| `trophy.png` | 242×284 | trophée (objet) | 1ʳᵉ marche du podium **uniquement** |
| `lock.png` | 197×215 | médaillon cadenas | avatars / boutons joueur désactivés |
| `ico-check.png` | 196×173 | tuile ✓ | `.stamp--correct .stamp__icon` |
| `ico-close.png` | 196×173 | tuile ✕ | `.player-card__remove` |
| `ico-home.png` | 196×173 | tuile maison | `#btn-home` |
| `ico-left.png` | 196×173 | tuile flèche | `.arcade-btn--icon` (défaut) |
| `ico-list.png` | 196×173 | tuile liste | `#btn-sessions::before` |
| `ico-gear.png` | 196×173 | tuile engrenage | `#btn-app-settings::before` |
| `ico-plus.png` | 196×173 | tuile + | `.add-player-btn::before` |
| `ico-star.png` | 196×173 | tuile étoile | jeton du meneur dans le mini-classement |
| `ico-trophy.png` | 196×173 | tuile trophée | `.arcade-trophy::before` (décompte de victoires d'une session) |
| `heart.png` | 245×195 | — | **non utilisé**, ne pas le câbler sans raison de sens |

Règle : un sprite n'est posé que là où **son sens** correspond, jamais pour la seule décoration.

---

## 3. Jetons

```css
[data-color-theme="paper"] {
  color-scheme: light;
  --font-button: 'Nerko One', var(--font-sans);
  --font-display: var(--font-sans);

  /* Surfaces */
  --bg-void: #e9d5b2;
  --bg-surface: #fdf8ea;
  --bg-surface-raised: #fffdf3;
  --bg-surface-soft: #f0e2c4;

  /* Accents et sémantique */
  --color-accent-primary: #563307;
  --color-accent-cyan: #16607f;
  --color-accent-pink: #a8283c;
  --color-accent-lime: #5e6a0c;
  --color-success: #4f6b0e;
  --color-error: #a8202c;
  --color-warning: #8a5600;

  /* Encre */
  --color-text: #4a1f14;
  --color-muted: #6d4534;
  --color-border: #560e12;
  --color-overlay: rgba(52, 20, 12, .62);

  /* Fonds */
  --gradient-bg: linear-gradient(170deg, #f6e8ce 0%, #e9d5b2 55%, #ddc49c 100%);
  --texture: radial-gradient(120% 80% at 50% 0%, rgba(255, 252, 240, .9) 0%, rgba(240, 222, 190, 0) 60%);
  --gradient-surface: linear-gradient(180deg, rgba(255, 255, 255, .55), rgba(255, 255, 255, 0));
  --gradient-accent: none;

  /* Encre posée SUR un aplat */
  --accent-contrast: #fff7e2;
  --on-success: #fff7e2;
  --on-pink: #fff7e2;

  /* Ombres : franches, sans flou */
  --shadow-card: 0 .1364em 0 rgba(86, 14, 18, .22);   /* 0 3px 0 */
  --shadow-pop:  0 .1818em 0 rgba(86, 14, 18, .3);    /* 0 4px 0 */
  --glow-accent: none;
  --text-glow: none;

  /* Rayons */
  --radius-sm: .2727em;  /* 6px */
  --radius-md: .3636em;  /* 8px */
  --radius-lg: .5455em;  /* 12px */
  --radius-xl: .7273em;  /* 16px */
  /* --radius-pill n'est pas redéfini : il reste à sa valeur globale (999px ≈ 45.4091em). */
}

[data-color-theme="paper"] ::selection { background: #e69912; color: #4a1f14; }
```

`--color-focus` n'est pas redéfini : il vaut `var(--color-accent-primary)` (`#563307`), brun foncé,
bien visible sur le parchemin. L'anneau global est `outline: .1364em solid var(--color-focus); outline-offset: .0909em;`
(3px / 2px), **à l'extérieur** du contrôle — indispensable, sinon il se confond avec les cadres 9-slice.

---

## 4. Scène, matière, mouvement

À placer dans la section « MATIÈRE ET MOUVEMENT » de `theme.css`, **après** le bloc de jetons.

```css
[data-color-theme="paper"] {
  /* Lumière de bougie en haut, planches verticales (tous les 96px),
     joints horizontaux (tous les 140px). */
  --stage-backdrop:
    radial-gradient(60% 45% at 50% 0%, rgba(255, 246, 214, .55), transparent 70%),
    repeating-linear-gradient(90deg,
      rgba(86, 14, 18, .1) 0 .1364em, transparent .1364em 4.3636em),   /* 3px / 96px */
    repeating-linear-gradient(0deg,
      rgba(86, 14, 18, .05) 0 .0909em, transparent .0909em 6.3636em);  /* 2px / 140px */
  --stage-vignette: radial-gradient(120% 95% at 50% 35%, transparent 48%, rgba(74, 31, 20, .34) 100%);

  --material-edge: .0909em solid var(--color-border);                  /* 2px */
  --material-depth: 0 .1364em 0 rgba(86, 14, 18, .22);                 /* 0 3px 0 */
  --material-sheen: linear-gradient(180deg, rgba(255, 255, 255, .45), transparent 45%);

  --motion-ease: cubic-bezier(.25, 1.2, .5, 1);
  --motion-enter-dur: 240ms;
  --motion-pop: .75;
}
```

> Les calques `#stage-*` sont `position: fixed` et n'héritent que de la police de `body`.
> Si `body` n'est pas à 22 px, les pas des planches changent : les passer en `rem` si on veut un pas fixe.

Les animations (`card-deal`, `token-place`, `stamp-in`, `lift-in`, `delta-rise`, `rise-in`) sont
génériques dans `stage.css` et lisent `--motion-*`. Paper Quest n'ajoute aucune keyframe.
Elles sont neutralisées par le bloc `prefers-reduced-motion` de `components.css`.

---

## 5. Composants du jeu

L'**ordre des règles compte** : plusieurs sélecteurs sont d'abord cernés d'un trait (§5.1) puis
repris par un cadre 9-slice plus bas (§5.4, §5.5). Respecter l'ordre ci-dessous.

### 5.1 Trait sombre sur toutes les surfaces

```css
[data-color-theme="paper"] .panel,
[data-color-theme="paper"] .question-card,
[data-color-theme="paper"] .option-card,
[data-color-theme="paper"] .answer-card,
[data-color-theme="paper"] .podium__row,
[data-color-theme="paper"] .player-card,
[data-color-theme="paper"] .leaderboard-mini__item {
  border: .0909em solid var(--color-border);   /* 2px */
}
```

État final : `.option-card`, `.player-card`, `.leaderboard-mini__item` et les `.podium__row` **hors**
`.podium--steps` gardent ce trait. Les autres sont repris plus bas.

### 5.2 Boutons `.button` — parchemin cerné, pas de plaque peinte

Pourquoi : les plaques `bar-*.png` sont de luminance moyenne ; aucune encre n'y atteint 4,5:1
(crème 1,9–2,4:1, encre sombre 3,2–4,3:1). Les petits boutons portent donc leur couleur sur le
liseré et leur texte sur du parchemin.

```css
[data-color-theme="paper"] .button {
  border: .0909em solid var(--color-border);          /* 2px */
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  box-shadow: 0 .0909em 0 rgba(86, 14, 18, .25);      /* 0 2px 0 */
  color: var(--color-text);
  font-weight: 700;
  min-height: 1.4545em;                               /* 32px */
}
[data-color-theme="paper"] .button:hover:not(:disabled) { background: var(--bg-surface-soft); }
[data-color-theme="paper"] .button:active:not(:disabled) {
  background: var(--bg-surface-soft);
  transform: translateY(.0909em);                     /* 2px : le bouton s'enfonce */
  box-shadow: none;
}
[data-color-theme="paper"] .button:disabled { opacity: .5; box-shadow: none; }

/* Orange sur encre sombre : 4,79:1, la seule teinte du kit qui passe AA en petit texte. */
[data-color-theme="paper"] .button--primary { background: #f8a818; color: #3a1408; }
[data-color-theme="paper"] .button--danger  { color: var(--color-error); }
[data-color-theme="paper"] .button--ghost {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}
```

> `.button` a `font-size: var(--text-ui)` : `min-height` et le trait suivent cette taille.

### 5.3 Petits pictogrammes : bonus, score, podium, manches

Colonne « hôte » : valeur recalculée sur la taille réelle de l'hôte si on refuse la mise à l'échelle (§0.2).

```css
/* Étoile dorée sur la question bonus (hôte .badge, --text-meta ≈ 13px) */
[data-color-theme="paper"] .badge--bonus::before {
  content: '';
  width: .6818em;          /* 15px — hôte 13px : 1.1538em */
  height: .7273em;         /* 16px — hôte 13px : 1.2308em */
  margin-right: .1818em;   /* 4px  — hôte 13px : .3077em  */
  background: center / contain no-repeat url('/paper-ui/star-gold.png');
}

/* Pièce devant chaque score */
[data-color-theme="paper"] .answer-card__score::before {
  content: '';
  display: inline-block;
  width: .6364em;          /* 14px */
  height: .6364em;         /* 14px */
  margin-right: .1818em;   /* 4px */
  vertical-align: -.0909em;/* -2px */
  background: center / contain no-repeat url('/paper-ui/coin.png');
}

/* Podium : les sprites remplacent les émojis de rang (texte rendu transparent) */
[data-color-theme="paper"] .podium__rank {
  color: transparent;
  background: center / contain no-repeat;
  min-width: 1.1818em;     /* 26px */
  min-height: 1.2727em;    /* 28px */
}
[data-color-theme="paper"] .podium__row:nth-child(1) .podium__rank { background-image: url('/paper-ui/trophy.png'); }
[data-color-theme="paper"] .podium__row:nth-child(2) .podium__rank { background-image: url('/paper-ui/star-silver.png'); }
[data-color-theme="paper"] .podium__row:nth-child(3) .podium__rank { background-image: url('/paper-ui/star-gold.png'); }

/* Manches gagnées : étoile pleine / étoile terne */
[data-color-theme="paper"] .manche-pip {
  width: .6364em;          /* 14px */
  height: .6364em;
  border: 0;
  border-radius: 0;
  background: center / contain no-repeat url('/paper-ui/star-silver.png');
  opacity: .55;
}
[data-color-theme="paper"] .manche-pip--won {
  background-image: url('/paper-ui/star-gold.png');
  opacity: 1;
}
```

Le podium garde l'ordre DOM 1·2·3 (visuel 2·1·3 via `order`) : les `nth-child` ci-dessus restent justes.

### 5.4 Question et réponses : la feuille froissée

```css
[data-color-theme="paper"] .question-card,
[data-color-theme="paper"] .answer-card {
  border-style: solid;
  border-width: 0;
  border-image-source: url('/paper-ui/paper.png');
  border-image-slice: 60;            /* pixels du sprite : NE PAS convertir */
  border-image-width: .8182em;       /* 18px */
  border-image-repeat: stretch;
  border-radius: 0;
  background: #fdfdeb;               /* teinte exacte du papier, échantillonnée dans le PNG */
  box-shadow: none;
}
/* padding ≥ border-image-width, sinon la feuille mord sur le texte */
[data-color-theme="paper"] .question-card { padding: clamp(1.0909em, 2.5vw, 1.8182em); } /* 24px → 40px */
[data-color-theme="paper"] .answer-card   { padding: .9091em; }                          /* 20px */
```

**Pas de `fill`** sur `border-image-slice` : le centre du sprite contient l'ombre du froissé ; étiré
de 482 px à ~1400 px, il devient une traînée diagonale en travers de la question. On ne garde que le
bord déchiré, et le fond est peint en `#fdfdeb` (le creux du froissé est à `#ece9dc`, ne pas le prendre).

> Attention : `.question-card` a une `font-size` de question (`--text-question`). Si elle est
> posée sur la carte elle-même et non sur un enfant, `.8182em` et le padding grandissent d'autant.
> Dans ce cas, exprimer `border-image-width` et `padding` en `rem`.

### 5.5 Panneaux et marches du podium : le parchemin lacé

```css
[data-color-theme="paper"] .panel,
[data-color-theme="paper"] .podium--steps .podium__row {
  border-style: solid;
  border-width: 0;
  border-image-source: url('/paper-ui/frame.png');
  border-image-slice: 110 fill;      /* pixels du sprite ; `fill` voulu ici */
  border-image-width: 1.1818em;      /* 26px */
  border-image-repeat: round;        /* les coutures se répètent au lieu de s'étirer */
  border-radius: 0;
  background: none;
  box-shadow: none;
}
[data-color-theme="paper"] .panel { padding: 1.2727em; }                       /* 28px */
[data-color-theme="paper"] .podium--steps .podium__row { padding: 1.3636em 1.2727em; } /* 30px 28px */
```

`slice`, `width` et `repeat` sont **identiques** à ceux des menus (§6.3) pour que les coutures se
répètent de la même façon partout.

### 5.6 Pastille A/B/C/D

Pas de plaque peinte : la lettre est en `--text-option`, dont la borne basse (16,8 px) est sous le seuil
« grand texte ».

```css
[data-color-theme="paper"] .option-card__key {
  border: .0909em solid var(--color-border);   /* 2px */
  border-radius: var(--radius-sm);
  background-color: var(--bg-surface);
  background-image: none;
  color: var(--color-text);
}
```

> La règle de base met `color: var(--accent-contrast)` (crème) : sans cette surcharge, la lettre
> serait crème sur parchemin.

### 5.7 Rail de score du mini-classement

Aucun texte sur le rail : les plaques peintes y sont autorisées.

```css
[data-color-theme="paper"] .leaderboard-mini__rail {
  border: .0909em solid var(--color-border);   /* 2px */
  border-radius: var(--radius-sm);
  background: var(--bg-surface-soft);
  height: .6364em;                             /* 14px */
}
[data-color-theme="paper"] .leaderboard-mini__fill {
  background-color: transparent;
  background-image: url('/paper-ui/bar-d.png');   /* bleu pour tous */
  background-size: 100% 100%;
  background-repeat: no-repeat;
  box-shadow: none;
}
[data-color-theme="paper"] .leaderboard-mini__item--leader .leaderboard-mini__fill {
  background-image: url('/paper-ui/bar-a.png');   /* orange pour qui mène */
}

/* Le meneur est aussi marqué par une étoile : ne pas dépendre de la seule couleur. */
[data-color-theme="paper"] .leaderboard-mini__item--leader .leaderboard-mini__token::before {
  content: '';
  width: .7273em;          /* 16px */
  height: .6818em;         /* 15px */
  margin-right: .1364em;   /* 3px */
  flex: none;
  background: center / contain no-repeat url('/paper-ui/ico-star.png');
}
```

Contraintes :
- l'étoile se pose **dans le jeton** (`.leaderboard-mini__token`), pas sur le couloir : le couloir est une
  grille à 5 colonnes, un `::before` y deviendrait un 6ᵉ élément renvoyé à la ligne ;
- c'est `::before` et non `::after`, car `::after` porte déjà l'info-bulle de `.player-chip` ;
- l'hôte `.leaderboard-mini__token` est en `--text-player` (≈16–20 px) : l'étoile suit cette taille ;
- l'orange du meneur **redouble** le liseré du couloir meneur, il ne le remplace pas.

### 5.8 Tampon de révélation

```css
[data-color-theme="paper"] .stamp--correct .stamp__icon {
  color: transparent;
  width: 1.5em;
  height: 1.35em;
  background: center / contain no-repeat url('/paper-ui/ico-check.png');
}
```

Déjà en em relatifs au tampon : ne pas toucher. Le tampon « option drôle » (`.stamp--funny`, 😂) n'est
pas habillé : un emoji couleur est une image, `color: transparent` ne le masquerait pas.

### 5.9 Delta de points

```css
[data-color-theme="paper"] .answer-delta {
  border: .0909em solid var(--color-border);   /* 2px */
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
}
[data-color-theme="paper"] .answer-delta--plus::before {
  content: '';
  display: inline-block;
  width: .6364em;          /* 14px */
  height: .6364em;
  margin-right: .2273em;   /* 5px */
  vertical-align: -.0909em;/* -2px */
  background: center / contain no-repeat url('/paper-ui/coin.png');
}
```

Pas de pièce sur `.answer-delta--moins` : une perte n'est pas un gain.

### 5.10 CTA de l'écran de jeu `#btn-reveal`

Même traitement que `#btn-start` (§6.4). La plaque orange impose un libellé en `--text-menu-lg`
(plancher 19 px) pour rester en « grand texte ».

```css
[data-color-theme="paper"] #btn-reveal {
  border: 0;
  border-style: solid;
  border-width: 0;
  border-image-source: url('/paper-ui/bar-a.png');
  border-image-slice: 0 40 fill;       /* pixels du sprite */
  border-image-width: 0 .8182em;       /* 0 18px : seuls les bouts gauche/droit */
  border-image-repeat: stretch;
  border-radius: 0;
  background: none;
  box-shadow: none;
  color: #3a1408;
  font-size: var(--text-menu-lg);
}
```

Le balisage est `<button id="btn-reveal" class="button button--primary button--large">` : cette règle
par id doit l'emporter sur `.button--primary` du thème (fond orange uni). Vérifier la spécificité.

### 5.11 Chrono

```css
[data-color-theme="paper"] .timer {
  border: .0909em solid var(--color-border);   /* 2px */
  border-radius: var(--radius-sm);             /* rectangle, plus une pilule */
}
```

Le remplissage (dégradé piloté par `--t`) et les états `--urgent` / `--over` restent ceux de base.

### 5.12 Verrouillage : le cadenas

Un joueur éliminé par la mort subite et un avatar déjà pris sont le même état : hors d'atteinte.

```css
[data-color-theme="paper"] .option-card__player-btn:disabled,
[data-color-theme="paper"] .emoji-picker__item:disabled {
  opacity: 1;                               /* on annule l'estompage de base */
  background-color: var(--bg-surface-soft);
  position: relative;
}
[data-color-theme="paper"] .option-card__player-btn:disabled::before,
[data-color-theme="paper"] .emoji-picker__item:disabled::before {
  content: '';
  position: absolute;
  right: -.1364em;         /* -3px */
  bottom: -.1364em;        /* -3px */
  width: .8182em;          /* 18px */
  height: .8182em;
  background: center / contain no-repeat url('/paper-ui/lock.png');
}
```

Le cadenas se pose **en coin** : l'avatar reste visible, on doit savoir de qui il s'agit.

### 5.13 Boutons d'icône et tuiles d'annonce

```css
/* Suppression d'un joueur : la tuile ✕ remplace le glyphe.
   Voir §0.2 : NE PAS utiliser font-size: 0 avec des dimensions en em. */
[data-color-theme="paper"] .player-card__remove {
  border: 0;
  color: transparent;
  background: center / contain no-repeat url('/paper-ui/ico-close.png');
  /* width/height de base : 36px → 1.6364em */
}

/* Ajouter un joueur (bouton .button, donc inline-flex) */
[data-color-theme="paper"] .add-player-btn::before {
  content: '';
  width: 1em;              /* 22px */
  height: .9091em;         /* 20px */
  margin-right: .3636em;   /* 8px */
  background: center / contain no-repeat url('/paper-ui/ico-plus.png');
}
```

Le libellé actuel est « + Ajouter un joueur » : la tuile + double le « + » textuel. C'est l'état
actuel du dépôt, le conserver tel quel sauf instruction contraire.

### 5.14 Carte de mode sélectionnée

La sélection de base se lit via `--color-accent-primary` sur la bordure, soit la teinte que ce thème
donne déjà à **toutes** les bordures : invisible. L'étoile le dit sans la couleur.

```css
[data-color-theme="paper"] .mode-card--on {
  background: var(--bg-surface-soft);
  box-shadow: 0 .1364em 0 rgba(86, 14, 18, .3);   /* 0 3px 0 */
}
[data-color-theme="paper"] .mode-card--on .mode-card__name::after {
  content: '';
  display: inline-block;
  width: .6818em;          /* 15px — hôte --text-meta 13px : 1.1538em */
  height: .7273em;         /* 16px — hôte 13px : 1.2308em */
  margin-left: .2273em;    /* 5px  — hôte 13px : .3846em  */
  vertical-align: -.1364em;/* -3px — hôte 13px : -.2308em */
  background: center / contain no-repeat url('/paper-ui/star-gold.png');
}
```

---

## 6. Menus (accueil, sessions, réglages)

`arcade.css` ne pose que de la structure et des jetons. **Les sprites des menus n'existent que dans le
bloc Paper Quest.**

### 6.1 Titres

```css
[data-color-theme="paper"] .arcade__title h1,
[data-color-theme="paper"] .arcade__bar h1 {
  font-family: 'Irish Grover', var(--font-sans);
  color: #fff7e2;
  -webkit-text-stroke: .1364em var(--color-border);   /* 3px — voir note */
  paint-order: stroke fill;                           /* le trait passe SOUS le remplissage */
}
[data-color-theme="paper"] .arcade__title h1 {
  text-shadow: 0 .2273em 0 rgba(86, 14, 18, .35);    /* 0 5px 0 */
}
```

> Note : `.arcade__title h1` est en `--text-hero` (jusqu'à 72 px). En em, le contour de 3 px devient
> ~10 px au maximum et l'ombre ~16 px. Si le rendu doit rester celui d'origine (trait fixe de 3 px),
> utiliser `.1364rem` et `.2273rem`.

### 6.2 Boutons de menu `.arcade-btn` — les plaques peintes

Autorisées ici parce que les libellés sont en `--text-menu` (≥ 19 px, gras) : critère « grand texte » 3:1.

```css
[data-color-theme="paper"] .arcade-btn {
  border: 0;
  border-style: solid;
  border-width: 0;
  border-image-source: url('/paper-ui/bar-b.png');
  border-image-slice: 0 40 fill;       /* pixels du sprite */
  border-image-width: 0 .8182em;       /* 0 18px */
  border-image-repeat: stretch;
  border-radius: 0;
  background: none;
  box-shadow: none;
  color: #3a1408;
  text-shadow: 0 .0455em 0 rgba(255, 247, 226, .45);   /* 0 1px 0 */
}
[data-color-theme="paper"] .arcade-btn:hover:not(:disabled)  { background: none; filter: brightness(1.07); }
[data-color-theme="paper"] .arcade-btn:active:not(:disabled) { background: none; filter: brightness(.94); }
[data-color-theme="paper"] .arcade-btn:disabled {
  border-image-source: url('/paper-ui/bar-e.png');
  opacity: 1;
  color: rgba(58, 20, 8, .55);
}
[data-color-theme="paper"] .arcade-btn--primary {
  border-image-source: url('/paper-ui/bar-a.png');
  background: none;
  color: #3a1408;
}
[data-color-theme="paper"] .arcade-btn--danger {
  border-image-source: url('/paper-ui/bar-c.png');
  color: #fff7e2;
  text-shadow: 0 .0455em 0 rgba(83, 13, 17, .6);       /* 0 1px 0 */
}

/* Bouton d'icône : la tuile remplace la plaque et le glyphe.
   Voir §0.2 : color transparent, PAS font-size: 0 (sinon width en em = 0). */
[data-color-theme="paper"] .arcade-btn--icon {
  border-image: none;
  border: 0;
  color: transparent;
  text-shadow: none;
  width: 2.4545em;         /* 54px, à la font-size de base 22px */
  background: center / contain no-repeat url('/paper-ui/ico-left.png');
}
/* Le bouton de retour des réglages ramène au menu : c'est une maison. */
[data-color-theme="paper"] #btn-home { background-image: url('/paper-ui/ico-home.png'); }
```

> `.arcade-btn--icon` a `font-size: 24px` dans `arcade.css`. Pour que `2.4545em` fasse bien 54 px,
> soit le passer à `1em`/22 px dans le bloc du thème, soit écrire `width: 2.25em` (54 / 24).
> Choisir l'un des deux et le dire dans le commit.

### 6.3 Plaques et cartes de session : le parchemin lacé

```css
[data-color-theme="paper"] .arcade-plaque,
[data-color-theme="paper"] .arcade-card {
  border-style: solid;
  border-width: 0;
  border-image-source: url('/paper-ui/frame.png');
  border-image-slice: 110 fill;
  border-image-width: 1.1818em;      /* 26px */
  border-image-repeat: round;
  border-radius: 0;
  background: none;
  box-shadow: none;
}
[data-color-theme="paper"] .arcade-card          { padding: 1.2727em .9091em; }  /* 28px 20px */
[data-color-theme="paper"] .arcade-plaque--slim  { padding: .5455em .9091em; }   /* 12px 20px */

/* Session active : ombre portée (pas de bordure colorée) + étoile après le nom */
[data-color-theme="paper"] .arcade-card--active {
  border-color: transparent;
  box-shadow: none;
  filter: drop-shadow(0 .1818em .4545em rgba(86, 14, 18, .3));   /* 0 4px 10px */
}
[data-color-theme="paper"] .arcade-card--active .arcade-card__name::after {
  content: '';
  display: inline-block;
  width: .8182em;          /* 18px */
  height: .9091em;         /* 20px */
  margin-left: .2727em;    /* 6px */
  vertical-align: -.1364em;/* -3px */
  background: center / contain no-repeat url('/paper-ui/star-gold.png');
}
```

> `.arcade-plaque--slim` : padding vertical 12 px < `border-image-width` 26 px. C'est l'état actuel ;
> la plaque fine est assez haute pour que le texte ne soit pas mordu. À vérifier visuellement.

### 6.4 Tuiles d'annonce et CTA des réglages

```css
/* Tuiles devant les entrées de menu : elles annoncent, le libellé reste sur la plaque. */
[data-color-theme="paper"] #btn-sessions::before,
[data-color-theme="paper"] #btn-app-settings::before {
  content: '';
  width: 1.1818em;         /* 26px */
  height: 1.0909em;        /* 24px */
  margin-right: .4545em;   /* 10px */
  flex: none;
  background: center / contain no-repeat;
}
[data-color-theme="paper"] #btn-sessions::before     { background-image: url('/paper-ui/ico-list.png'); }
[data-color-theme="paper"] #btn-app-settings::before { background-image: url('/paper-ui/ico-gear.png'); }

/* Décompte de victoires d'une session : la TUILE trophée.
   L'objet trophy.png reste réservé à la 1re marche du podium. */
[data-color-theme="paper"] .arcade-trophy::before {
  content: '';
  width: 1.0909em;         /* 24px */
  height: 1em;             /* 22px */
  background: center / contain no-repeat url('/paper-ui/ico-trophy.png');
}

/* Bouton « Générer la partie » : plaque orange, libellé grand texte. */
[data-color-theme="paper"] .arcade--setup #btn-start {
  border: 0;
  border-style: solid;
  border-width: 0;
  border-image-source: url('/paper-ui/bar-a.png');
  border-image-slice: 0 40 fill;
  border-image-width: 0 .8182em;     /* 0 18px */
  border-image-repeat: stretch;
  border-radius: 0;
  background: none;
  box-shadow: none;
  color: #3a1408;
  font-size: var(--text-menu-lg);
}
```

Notes :
- `#btn-sessions` existe à **trois** endroits : accueil (`.arcade-btn`), réglages
  (`.arcade-btn--small`) et victoire (`.button--ghost`). La tuile s'affiche sur les trois ; les trois
  hôtes sont en `inline-flex`, donc le `::before` se place bien.
- Dans le dépôt actuel, `.arcade-trophy::before` est déclaré **deux fois** (une avec `trophy.png` 22×26,
  puis une avec `ico-trophy.png` 24×22 qui l'emporte). Une seule règle suffit : celle ci-dessus.
- `#btn-start` a le balisage `button button--primary button--large` : la règle par id doit gagner sur
  `.button--primary` du thème.

---

## 7. Contraintes non négociables

1. **Contraste des plaques peintes.** `bar-*.png` ne portent que du **grand texte** (≥ 18,66 px en gras)
   ou aucun texte. Mesures : 3,69 à 4,79:1. D'où :
   - `--text-menu: clamp(.8636em, 1.6vw, 1.1818em)` (19 → 26 px) et
     `--text-menu-lg: clamp(.9545em, 2.1vw, 1.4545em)` (21 → 32 px) : **le plancher de 19 px ne descend jamais** ;
   - `font-weight: 700` conservé sur les boutons alors que Nerko One n'existe qu'en 400 : le gras
     synthétique maintient le critère « grand texte ». Le repasser à 400 ferait basculer le seuil à 4,5:1.
2. **`border-image` ne réserve pas d'espace.** Le `padding` doit être ≥ `border-image-width`, sinon le cadre
   recouvre le texte (feuille : 18 px → padding ≥ 20 px ; parchemin : 26 px → padding ≥ 28 px).
3. **`border-image-slice` est en pixels du sprite**, jamais converti en em.
4. **`paper.png` sans `fill`**, fond peint en `#fdfdeb`. **`frame.png` avec `fill`**, `repeat: round`.
5. **Aucun état porté par la couleur seule** : meneur = orange **et** étoile ; mode choisi = fond **et**
   étoile ; session active = ombre **et** étoile ; verrou = fond **et** cadenas.
6. **Anneau de focus à l'extérieur** du contrôle (`outline-offset` positif), sinon il disparaît dans les cadres.
7. **Sprites seulement dans `theme.css`**, sous `[data-color-theme="paper"]`. Aucun autre thème n'en hérite.
8. **`em` et `font-size: 0` sont incompatibles** : ne jamais masquer un libellé par `font-size: 0` sur un
   élément dimensionné en em (§0.2).

---

## 8. Vérification

1. `npm run dev`, vider `localStorage` (clé `quizz-canape:color-theme`) → Paper Quest doit s'afficher par défaut.
2. Sur chaque écran (accueil, sessions, réglages, jeu en question, jeu en révélation, victoire) :
   - aucun texte mordu par un cadre ;
   - les boutons d'icône (`#btn-home`, `.player-card__remove`) ont une taille non nulle et montrent leur tuile ;
   - `#btn-start` et `#btn-reveal` sont des plaques orange avec libellé ≥ 19 px ;
   - le meneur a une étoile dans son jeton **et** un rail orange ;
   - un avatar pris montre un cadenas en coin, l'emoji restant visible ;
   - la question n'a pas de traînée diagonale au centre ;
   - navigation au clavier : l'anneau de focus brun est visible sur chaque plaque et chaque cadre.
3. Largeurs 320 px, 768 px, 1920 px : les `clamp()` tiennent, les cadres ne se déforment pas.
4. `prefers-reduced-motion: reduce` : aucune animation d'entrée.
5. Changer de thème puis revenir à Paper Quest : aucun sprite ne subsiste sur les autres thèmes.
