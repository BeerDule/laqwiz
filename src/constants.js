// constants.js — valeurs constantes partagées par l'application.

export const PLAYER_EMOJIS = [
  '😀', '🦊', '🐼', '🐸', '🐙', '🦄', '🐯', '🐨', '🦁', '🐵',
];

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

export const STORAGE_KEYS = {
  players: 'quizz-canape:players',
  settings: 'quizz-canape:settings',
  stats: 'quizz-canape:stats',
  activeSession: 'quizz-canape:active-session',
};

export const DEFAULTS = {
  theme: 'Culture générale',
  targetScore: 15,
  twoPointLead: false,
  bonusEnabled: false,
  difficulty: 'balanced', // 'balanced' | 'easy' | 'medium' | 'hard'
  audience: 'general',    // 'kids' | 'general' | 'nsfw'
  timerEnabled: false,
  timePerQuestion: 60,    // secondes, voir TIMER_CHOICES
  penaltyNoAnswer: false,   // -1 point si le joueur n'a pas répondu
  penaltyWrongAnswer: false, // mode punisher : -1 point si mauvaise réponse
  punisherSeverity: 'punitive', // 'punitive' | 'ultra', voir PUNISHER_CHOICES
  manchesTarget: 3,             // best-of, voir MANCHE_CHOICES
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
  'bubble-island': { label: 'Bubble Island' },
  paper:   { label: 'Paper Quest' },
};
export const DEFAULT_COLOR_THEME = 'default';

export const DIFFICULTY_LABELS = {
  easy: 'Facile',
  medium: 'Moyen',
  hard: 'Difficile',
};
