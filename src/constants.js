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
export const BONUS_CHANCE = 0.15; // ~15 % de chance qu'une question soit bonus

export const STORAGE_KEYS = {
  players: 'quizz-canape:players',
  settings: 'quizz-canape:settings',
  stats: 'quizz-canape:stats',
};

export const DEFAULTS = {
  theme: 'Culture générale',
  targetScore: 15,
  twoPointLead: false,
  bonusEnabled: false,
  model: 'mammouth-chat',
  temperature: 0.9,
  batchSize: BATCH_SIZE,
};

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

export const DIFFICULTY_LABELS = {
  easy: 'Facile',
  medium: 'Moyen',
  hard: 'Difficile',
};
