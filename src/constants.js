// constants.js — valeurs constantes partagées par l'application.

/**
 * Avatars des joueurs.
 *
 * Choisis pour rester lisibles à 24 px sur les dix thèmes : aplat saturé, masse
 * sombre ou motif interne contrasté. Les pastels (panda, koala, licorne) ont été
 * écartés — leur contour se dissout sur les thèmes clairs et il ne reste que les
 * yeux. Tous sont en un seul point de code : pas de séquence ZWJ qui pourrait
 * s'afficher en plusieurs glyphes, et la comparaison stricte reste fiable.
 */
export const PLAYER_EMOJIS = [
  // Canon jeu vidéo
  '👾', '🤖', '👻', '👽', '👹', '🐲', '🍄', '💣', '💀', '👺', '🎃',
  // Visages d'animaux à forte signature
  '🦊', '🦁', '🐵', '🦝', '🐷', '🐗', '🦓', '🐮', '🐴', '🐺', '🐻', '🐸',
  // Créatures à silhouette tranchée
  '🐙', '🐧', '🦉', '🐝', '🐞', '🦀', '🐢',
];

/**
 * Noms français des avatars, pour les lecteurs d'écran et les info-bulles.
 * Sans cela, la grille de choix n'annoncerait que « bouton » trente fois.
 */
export const PLAYER_EMOJI_LABELS = {
  '👾': 'Invader', '🤖': 'Robot', '👻': 'Fantôme', '👽': 'Alien', '👹': 'Oni',
  '🐲': 'Dragon', '🍄': 'Champignon', '💣': 'Bombe', '💀': 'Crâne',
  '👺': 'Tengu', '🎃': 'Citrouille',
  '🦊': 'Renard', '🦁': 'Lion', '🐵': 'Singe', '🦝': 'Raton laveur',
  '🐷': 'Cochon', '🐗': 'Sanglier', '🦓': 'Zèbre', '🐮': 'Vache',
  '🐴': 'Cheval', '🐺': 'Loup', '🐻': 'Ours', '🐸': 'Grenouille',
  '🐙': 'Poulpe', '🐧': 'Manchot', '🦉': 'Hibou', '🐝': 'Abeille',
  '🐞': 'Coccinelle', '🦀': 'Crabe', '🐢': 'Tortue',
};

// Palette auto dans l'ordre : violet, cyan, rose, lime, ambre, bleu.
export const PLAYER_COLORS = [
  '#a855f7', // violet
  '#22d3ee', // cyan
  '#f472b6', // rose
  '#a3e635', // lime
  '#fbbf24', // ambre
  '#3b82f6', // bleu
];

export const PRESET_THEMES = [
  'Culture générale',
  'Cinéma & séries',
  'Musique',
  'Sciences & nature',
  'Histoire',
  'Sport',
  'Gastronomie',
  'Jeux vidéo',
];

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const NAME_MAX_LENGTH = 18;
export const THEME_MIN_LENGTH = 2;
export const THEME_MAX_LENGTH = 60;
export const TARGET_SCORE_MIN = 5;
export const TARGET_SCORE_MAX = 30;
export const BATCH_SIZE = 5;
// Caractères d'article envoyés par lot (~900 tokens). Un article complet monte
// à 178 000 caractères : le réexpédier à chaque lot serait ruineux.
export const SOURCE_BUDGET_CHARS = 3500;
export const BONUS_CHANCE = 0.15; // ~15 % de chance qu'une question soit bonus

/**
 * Champs de réglage qu'un mode de jeu pilote.
 *
 * Volontairement restreint aux RÈGLES. Le thème, la source Wikipédia et la
 * configuration LLM n'en font pas partie : on veut pouvoir passer de
 * « Canap' éritif » à « Canap' ocalypse » sans perdre l'article qu'on venait de
 * choisir. C'est aussi cette liste qui sert à détecter qu'un mode a été
 * retouché — voir `diffFromMode` dans modes.js.
 */
export const MODE_RULE_KEYS = [
  'targetScore', 'twoPointLead', 'bonusEnabled', 'difficulty', 'audience',
  'timerEnabled', 'timePerQuestion', 'penaltyNoAnswer', 'penaltyWrongAnswer',
  'punisherSeverity', 'manchesTarget', 'suddenDeathEnabled', 'suddenDeathStrikes',
];

/**
 * Modes fournis avec le jeu. Semés en base à la première ouverture, puis
 * modifiables comme les modes perso.
 *
 * `version` permet de pousser une correction sur un mode fourni : au démarrage,
 * un enregistrement d'une version antérieure est remplacé — SAUF si le MJ l'a
 * retouché lui-même (`dirty`), auquel cas son réglage gagne. Toute correction
 * d'un mode ci-dessous doit donc s'accompagner d'un incrément de sa `version`,
 * sans quoi elle n'atteindra aucun appareil déjà ouvert.
 */
export const BUILTIN_MODES = [
  {
    id: 'eritif',
    name: "Canap' éritif",
    emoji: '🍸',
    tagline: 'Le mode tranquille pour les apéros discussions',
    version: 1,
    order: 10,
    settings: {
      targetScore: 10, twoPointLead: false, bonusEnabled: false,
      difficulty: 'easy', audience: 'general',
      timerEnabled: false, timePerQuestion: 60,
      penaltyNoAnswer: false, penaltyWrongAnswer: false,
      punisherSeverity: 'punitive', manchesTarget: 1,
      suddenDeathEnabled: false, suddenDeathStrikes: 3,
    },
  },
  {
    id: 'aulit',
    name: "Canap' au lit",
    emoji: '🌙',
    tagline: 'Le mode famille, chrono d\'une minute et zéro sanction',
    version: 1,
    order: 20,
    settings: {
      targetScore: 10, twoPointLead: false, bonusEnabled: false,
      difficulty: 'easy', audience: 'kids',
      timerEnabled: true, timePerQuestion: 60,
      penaltyNoAnswer: false, penaltyWrongAnswer: false,
      punisherSeverity: 'punitive', manchesTarget: 1,
      suddenDeathEnabled: false, suddenDeathStrikes: 3,
    },
  },
  {
    id: 'epice',
    name: "Canap' épicé",
    emoji: '🌶️',
    tagline: 'Une minute au chrono, la mauvaise réponse se paie',
    version: 1,
    order: 30,
    settings: {
      targetScore: 15, twoPointLead: false, bonusEnabled: false,
      difficulty: 'balanced', audience: 'general',
      timerEnabled: true, timePerQuestion: 60,
      penaltyNoAnswer: false, penaltyWrongAnswer: true,
      punisherSeverity: 'punitive', manchesTarget: 1,
      suddenDeathEnabled: false, suddenDeathStrikes: 3,
    },
  },
  {
    id: 'ero',
    name: "Canap' éro",
    emoji: '🔞',
    tagline: 'Le mode adulte pour les apéros bien arrosés',
    version: 1,
    order: 40,
    settings: {
      targetScore: 15, twoPointLead: false, bonusEnabled: false,
      difficulty: 'balanced', audience: 'nsfw',
      timerEnabled: true, timePerQuestion: 60,
      penaltyNoAnswer: false, penaltyWrongAnswer: true,
      punisherSeverity: 'punitive', manchesTarget: 1,
      suddenDeathEnabled: false, suddenDeathStrikes: 3,
    },
  },
  {
    id: 'ocalypse',
    name: "Canap' ocalypse",
    emoji: '🔥',
    tagline: 'Le mode hardcore : 30 secondes, aucune pitié',
    version: 1,
    order: 50,
    settings: {
      targetScore: 20, twoPointLead: true, bonusEnabled: true,
      difficulty: 'hard', audience: 'general',
      timerEnabled: true, timePerQuestion: 30,
      penaltyNoAnswer: true, penaltyWrongAnswer: true,
      punisherSeverity: 'ultra', manchesTarget: 3,
      suddenDeathEnabled: false, suddenDeathStrikes: 3,
    },
  },
];

/** Crédits affichés en pied de l'écran d'accueil. */
export const CREDITS = [
  { emoji: '👑', name: 'Lukia', role: 'le boss' },
  { emoji: '🌿', name: 'Westi', role: 'le druide' },
  { emoji: '🍳', name: 'Lio', role: 'le cuisto' },
];

/** Mode appliqué à une installation neuve. */
export const DEFAULT_MODE_ID = 'epice';
export const MODE_NAME_MAX_LENGTH = 24;

export const STORAGE_KEYS = {
  players: 'quizz-canape:players',
  settings: 'quizz-canape:settings',
  stats: 'quizz-canape:stats',
  activeSession: 'quizz-canape:active-session',
  llm: 'quizz-canape:llm',
};

export const DEFAULTS = {
  theme: 'Culture générale',
  // Les règles viennent du mode par défaut : sans cela, DEFAULTS et
  // BUILTIN_MODES divergeraient silencieusement à la première retouche.
  ...BUILTIN_MODES.find(m => m.id === DEFAULT_MODE_ID).settings,
  modeId: DEFAULT_MODE_ID,
  sourceMode: 'theme',          // 'theme' | 'wikipedia'
  sourceTitle: '',              // titre exact de l'article
  sourceLang: 'fr',             // sous-domaine Wikipédia
  sourceUrl: '',                // pour l'affichage et le lien
  model: '',
  baseUrl: '',
  apiKey: '',
  temperature: 0.9,
  batchSize: BATCH_SIZE,
};

// Choix proposés sur l'écran de création de partie (SPEC setup).
export const DIFFICULTY_CHOICES = [
  { value: 'balanced', label: 'Équilibré' },
  { value: 'easy', label: 'Facile' },
  { value: 'medium', label: 'Moyen' },
  { value: 'hard', label: 'Difficile' },
];

export const AUDIENCE_CHOICES = [
  { value: 'kids', label: 'Kid friendly' },
  { value: 'general', label: 'Tout public' },
  { value: 'nsfw', label: 'Adulte (NSFW)' },
];

// Nombre de manches d'une partie. Toujours impair : une majorité est alors
// toujours atteignable, donc pas d'égalité possible sur un best-of.
export const MANCHE_CHOICES = [
  { value: 1, label: '1 manche' },
  { value: 3, label: '3 manches' },
  { value: 5, label: '5 manches' },
  { value: 7, label: '7 manches' },
];

// Sévérité du mode punisher : « ultra » applique aussi le ×2 des questions
// bonus à la perte, « punitive » retire toujours 1 point.
export const SUDDEN_DEATH_CHOICES = [
  { value: 1, label: '1 faute' },
  { value: 2, label: '2 fautes' },
  { value: 3, label: '3 fautes' },
  { value: 5, label: '5 fautes' },
];

export const PUNISHER_CHOICES = [
  { value: 'punitive', label: 'Punitive (−1)' },
  { value: 'ultra', label: 'Ultra punitive (−2 en bonus)' },
];

// Durées proposées pour le mode chronomètre, en secondes.
export const TIMER_CHOICES = [
  { value: 30, label: '30 s' },
  { value: 60, label: '1 min' },
  { value: 120, label: '2 min' },
  { value: 180, label: '3 min' },
  { value: 240, label: '4 min' },
  { value: 300, label: '5 min' },
];

// Schéma JSON inliné dans le prompt système (voir SPEC §7.7).
export const QUESTION_SCHEMA_JSON = JSON.stringify({
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: [
          'id', 'theme', 'difficulty', 'question',
          'options', 'answer', 'funnyOption', 'explanation',
        ],
        properties: {
          id: { type: 'string' },
          theme: { type: 'string' },
          difficulty: { enum: ['easy', 'medium', 'hard'] },
          question: { type: 'string' },
          options: {
            type: 'array',
            minItems: 4,
            maxItems: 4,
            items: {
              type: 'object',
              required: ['key', 'text'],
              properties: {
                key: { enum: ['A', 'B', 'C', 'D'] },
                text: { type: 'string' },
              },
            },
          },
          answer: { enum: ['A', 'B', 'C', 'D'] },
          funnyOption: { enum: ['A', 'B', 'C', 'D'] },
          explanation: { type: 'string' },
        },
      },
    },
  },
  required: ['questions'],
}, null, 2);

export const COLOR_THEMES = {
  default: { label: 'VS Code' },
  matrix:  { label: 'Matrix' },
  girly:   { label: 'Girly' },
  win98:   { label: 'Windows 98' },
  jungle:  { label: 'Jungle' },
  kids:    { label: 'Kids Friendly' },
  apple:   { label: 'Apple' },
  'apple-glass': { label: 'Apple Glass' },
  paper:   { label: 'Paper Quest' },
  mecha:   { label: 'Mecha' },
};
export const DEFAULT_COLOR_THEME = 'mecha';

export const DIFFICULTY_LABELS = {
  easy: 'Facile',
  medium: 'Moyen',
  hard: 'Difficile',
};
