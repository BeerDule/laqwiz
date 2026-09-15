// modes.js — gestionnaire des modes de jeu.
//
// Un mode est un jeu de règles nommé : nombre de manches, chrono, pénalités,
// public, difficulté. Le sélectionner recopie ses règles dans les réglages de
// partie, qui restent librement retouchables ensuite.
//
// Les cinq modes fournis sont semés en base au premier démarrage puis vivent
// comme les autres. Ils ne sont pas supprimables : le semis les recréerait au
// rechargement, et supprimer les cinq laisserait un écran sans issue. On les
// « réinitialise » à la place.

import {
  BUILTIN_MODES, MODE_RULE_KEYS, MODE_NAME_MAX_LENGTH,
  TIMER_CHOICES, PUNISHER_CHOICES, MANCHE_CHOICES,
  DIFFICULTY_CHOICES, AUDIENCE_CHOICES,
  TARGET_SCORE_MIN, TARGET_SCORE_MAX,
} from './constants.js';
import { listModes, putMode, deleteMode } from './db.js';

const inChoices = (list, v) => list.some(c => c.value === v);

/**
 * Ne retient que des règles valides. Un enregistrement IndexedDB bricolé à la
 * main, ou écrit par une version antérieure, ne doit pas injecter n'importe
 * quoi dans une partie. Les champs absents ou refusés retombent sur le mode
 * fourni par défaut.
 */
export function sanitizeModeSettings(raw, fallback) {
  const base = fallback || BUILTIN_MODES.find(m => m.id === 'epice').settings;
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = { ...base };

  if (Number.isFinite(src.targetScore)) {
    out.targetScore = Math.min(TARGET_SCORE_MAX, Math.max(TARGET_SCORE_MIN, Math.round(src.targetScore)));
  }
  if (typeof src.twoPointLead === 'boolean') out.twoPointLead = src.twoPointLead;
  if (typeof src.bonusEnabled === 'boolean') out.bonusEnabled = src.bonusEnabled;
  if (typeof src.timerEnabled === 'boolean') out.timerEnabled = src.timerEnabled;
  if (typeof src.penaltyNoAnswer === 'boolean') out.penaltyNoAnswer = src.penaltyNoAnswer;
  if (typeof src.penaltyWrongAnswer === 'boolean') out.penaltyWrongAnswer = src.penaltyWrongAnswer;
  if (inChoices(DIFFICULTY_CHOICES, src.difficulty)) out.difficulty = src.difficulty;
  if (inChoices(AUDIENCE_CHOICES, src.audience)) out.audience = src.audience;
  if (inChoices(TIMER_CHOICES, src.timePerQuestion)) out.timePerQuestion = src.timePerQuestion;
  if (inChoices(PUNISHER_CHOICES, src.punisherSeverity)) out.punisherSeverity = src.punisherSeverity;
  if (inChoices(MANCHE_CHOICES, src.manchesTarget)) out.manchesTarget = src.manchesTarget;

  return out;
}

export function sanitizeModeName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  return name.slice(0, MODE_NAME_MAX_LENGTH);
}

/** Un seul caractère visible : les cartes n'ont pas la place pour davantage. */
export function sanitizeModeEmoji(raw) {
  const chars = [...String(raw ?? '').trim()];
  return chars.length ? chars.slice(0, 2).join('') : '🎲';
}

function recordFromBuiltin(b) {
  return {
    id: b.id, name: b.name, emoji: b.emoji, tagline: b.tagline,
    builtin: true, version: b.version, order: b.order,
    dirty: false, settings: { ...b.settings },
  };
}

/**
 * Quelles règles diffèrent entre des réglages de partie et un mode.
 *
 * Sert au badge « (modifié) ». On compare plutôt que de porter un drapeau :
 * un drapeau finit toujours par mentir — remettre à la main la valeur d'origine
 * doit faire disparaître le badge.
 *
 * @returns {string[]} les clés qui diffèrent, vide si le mode est intact
 */
export function diffFromMode(settings, mode) {
  if (!mode || !settings) return [];
  return MODE_RULE_KEYS.filter(k => settings[k] !== mode.settings[k]);
}

/**
 * Charge les modes, en semant ou rafraîchissant les fournis au passage.
 *
 * Un mode fourni retouché par le MJ (`dirty`) n'est jamais écrasé par une
 * nouvelle version : sa retouche est délibérée, la nôtre ne l'est pas pour lui.
 * Il garde le bouton « Réinitialiser » pour revenir aux valeurs d'origine.
 */
export async function loadModes() {
  const stored = await listModes();
  const byId = new Map(stored.map(m => [m.id, m]));

  const aEcrire = [];
  for (const b of BUILTIN_MODES) {
    const cur = byId.get(b.id);
    if (!cur) {
      aEcrire.push(recordFromBuiltin(b));
    } else if (!cur.dirty && (cur.version || 0) < b.version) {
      aEcrire.push({ ...recordFromBuiltin(b), name: cur.name, emoji: cur.emoji });
    }
  }
  await Promise.all(aEcrire.map(putMode));
  for (const m of aEcrire) byId.set(m.id, m);

  return [...byId.values()]
    .map(m => ({ ...m, settings: sanitizeModeSettings(m.settings) }))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

/** Crée un mode perso à partir des réglages courants. */
export function createMode(name, emoji, settings) {
  const mode = {
    id: `mode-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: sanitizeModeName(name) || 'Mode sans nom',
    emoji: sanitizeModeEmoji(emoji),
    tagline: '',
    builtin: false,
    version: 1,
    // Après les fournis (max 50), et strictement croissant pour que deux
    // créations de la même seconde ne se disputent pas la même place.
    order: 100 + Date.now() % 1_000_000,
    dirty: false,
    settings: sanitizeModeSettings(settings),
  };
  return putMode(mode).then(() => mode);
}

/**
 * Écrit une modification. Un mode fourni retouché est marqué `dirty` : c'est ce
 * qui le protège d'un écrasement au prochain semis.
 */
export function updateMode(mode, patch) {
  const next = { ...mode, ...patch };
  if (patch.settings) next.settings = sanitizeModeSettings(patch.settings);
  if (patch.name !== undefined) next.name = sanitizeModeName(patch.name) || mode.name;
  if (patch.emoji !== undefined) next.emoji = sanitizeModeEmoji(patch.emoji);
  if (next.builtin) next.dirty = true;
  return putMode(next).then(() => next);
}

/** Restaure un mode fourni dans ses valeurs d'origine. */
export function resetBuiltinMode(id) {
  const b = BUILTIN_MODES.find(m => m.id === id);
  if (!b) return Promise.resolve(null);
  const fresh = recordFromBuiltin(b);
  return putMode(fresh).then(() => fresh);
}

/** Les modes fournis ne se suppriment pas : le semis les recréerait. */
export function removeMode(mode) {
  if (!mode || mode.builtin) return Promise.resolve(false);
  return deleteMode(mode.id).then(() => true);
}
