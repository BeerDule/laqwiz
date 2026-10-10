// sfw.js — filtre « Safe For Work » côté client (esthétique, pas une règle serveur).
//
// Un simple filtre d'affichage persistant : quand il est actif, l'option
// « Adulte (NSFW) » et le mode « Canap' éro » sont masqués. La valeur vit en
// localStorage, propre à cet appareil ; le serveur ne l'impose plus.
const LS_KEY = 'quizz-canape:sfw';

function readStored() {
  try { return localStorage.getItem(LS_KEY) === '1'; } catch { return false; }
}

let active = readStored();

export function setSfw(value) {
  active = value === true;
  try { localStorage.setItem(LS_KEY, active ? '1' : '0'); } catch { /* quota/privé */ }
}

export function isSfw() {
  return active;
}

/** Retire l'option « Adulte (NSFW) » quand le filtre SFW est actif. */
export function audienceChoices(choices) {
  return active ? choices.filter(c => c.value !== 'nsfw') : choices;
}
