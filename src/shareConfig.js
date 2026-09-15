// shareConfig.js — partage de la configuration LLM par URL.
//
// AVERTISSEMENT : le lien produit contient la CLÉ API EN CLAIR. Base64 est un
// encodage, pas un chiffrement — quiconque possède le lien possède la clé.
// C'est acceptable pour passer sa config du portable à la TV du salon ; ça ne
// l'est pas pour publier le lien quelque part.
//
// Deux précautions en découlent, appliquées ailleurs dans le code :
//  - main.js retire `?config=` de la barre d'adresse dès l'import, pour que la
//    clé ne reste ni dans l'historique, ni dans un signet, ni dans un `Referer` ;
//  - l'écran de réglages affiche l'avertissement au moment de générer le lien.

const FORMAT_VERSION = 1;

/** base64url : `+` et `/` ne survivent pas à une query string — `+` y devient
 *  une espace. On utilise donc l'alphabet URL, sans remplissage. */
function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Encode la configuration partageable.
 * @param {object} settings  réglages courants
 * @param {string} theme     identifiant du thème de couleurs
 * @returns {string} charge utile base64url
 */
export function encodeShareConfig(settings, theme) {
  const payload = {
    v: FORMAT_VERSION,
    llm: {
      baseUrl: settings.baseUrl || '',
      apiKey: settings.apiKey || '',
      model: settings.model || '',
      temperature: settings.temperature,
    },
    theme: theme || undefined,
  };
  // TextEncoder plutôt que btoa direct : une URL ou un modèle peut contenir des
  // caractères non-ASCII, sur lesquels btoa lève.
  return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

/**
 * Décode une charge utile. Renvoie `{ llm, theme }` ou `null` si elle est
 * illisible. Chaque champ est revalidé : ce contenu vient d'une URL, donc de
 * n'importe où.
 */
export function decodeShareConfig(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(raw)));
  } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== FORMAT_VERSION) return null;

  const src = parsed.llm && typeof parsed.llm === 'object' ? parsed.llm : {};
  const llm = {};
  if (typeof src.baseUrl === 'string' && src.baseUrl.trim()) llm.baseUrl = src.baseUrl.trim().slice(0, 300);
  if (typeof src.apiKey === 'string' && src.apiKey.trim()) llm.apiKey = src.apiKey.trim().slice(0, 300);
  if (typeof src.model === 'string' && src.model.trim()) llm.model = src.model.trim().slice(0, 120);
  if (Number.isFinite(src.temperature)) llm.temperature = Math.min(2, Math.max(0, src.temperature));

  const theme = typeof parsed.theme === 'string' && /^[a-z-]{1,32}$/.test(parsed.theme)
    ? parsed.theme
    : null;

  if (!Object.keys(llm).length && !theme) return null;
  return { llm, theme };
}

/** Lien complet à partager, ancré sur l'origine courante. */
export function buildShareUrl(settings, theme, origin) {
  const url = new URL(origin || window.location.href);
  url.hash = '';
  url.search = '';
  // URLSearchParams ré-encoderait inutilement une charge déjà URL-safe.
  url.search = `?config=${encodeShareConfig(settings, theme)}`;
  return url.toString();
}
