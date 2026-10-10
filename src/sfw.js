// sfw.js — drapeau « Safe For Work » servi par le serveur au démarrage.
//
// Activé par SFW_MODE=1 dans l'environnement du serveur (relais auto-hébergé ou
// proxy Vite), puis exposé par GET /api/health et lu par applyHealthConfig()
// dans main.js. Tant que le serveur n'a pas répondu, on reste sur la valeur par
// défaut (false) : le mode n'est donc jamais actif sans que le serveur l'ait dit.

let active = false;

export function setSfw(value) {
  active = value === true;
}

export function isSfw() {
  return active;
}

/** Retire l'option « Adulte (NSFW) » quand le serveur est en mode SFW. */
export function audienceChoices(choices) {
  return active ? choices.filter(c => c.value !== 'nsfw') : choices;
}
