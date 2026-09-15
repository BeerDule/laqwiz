// db.js — archive IndexedDB (sessions et parties jouées).
//
// Répartition volontaire avec storage.js : le petit état chaud (roster,
// réglages, thème) reste en localStorage car main.js l'hydrate de façon
// synchrone avant le premier rendu. Seule l'archive, qui grossit sans limite,
// vit ici — sa lecture asynchrone ne bloque pas le démarrage.

const DB_NAME = 'quizz-canape';
const DB_VERSION = 4;
const STORE_SESSIONS = 'sessions';
const STORE_PARTIES = 'parties';
// Instantanés des parties EN COURS. Clé = identifiant de PARTIE, index sur la
// session : une même session peut donc avoir plusieurs parties interrompues.
const STORE_RESUME = 'resume';
// Modes de jeu : les cinq fournis y sont semés au démarrage, à côté de ceux
// que le MJ crée lui-même.
const STORE_MODES = 'modes';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB indisponible'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      // v2 indexait par session (une seule partie reprenable). v3 indexe par
      // partie. Le keyPath n'étant pas modifiable, le store est recréé — les
      // instantanés de la v2 sont donc perdus, mais aucune partie TERMINÉE ne
      // l'est : celles-ci vivent dans le store `parties`.
      if (event.oldVersion >= 2 && event.oldVersion < 3
          && db.objectStoreNames.contains(STORE_RESUME)) {
        db.deleteObjectStore(STORE_RESUME);
      }
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_RESUME)) {
        const resume = db.createObjectStore(STORE_RESUME, { keyPath: 'partieId' });
        resume.createIndex('sessionId', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_MODES)) {
        db.createObjectStore(STORE_MODES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PARTIES)) {
        const parties = db.createObjectStore(STORE_PARTIES, { keyPath: 'id' });
        parties.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(storeName, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.onabort = () => reject(tx.error);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

// Toute la surface publique avale ses erreurs : l'archive est un confort, pas
// une dépendance du jeu. Un navigateur en navigation privée qui refuse
// IndexedDB doit laisser la partie se dérouler normalement.
function safe(promise, fallback) {
  return promise.catch(error => {
    console.warn('[db] opération ignorée', error);
    return fallback;
  });
}

export function putSession(session) {
  return safe(run(STORE_SESSIONS, 'readwrite', st => st.put(session)), null);
}

export function getSession(id) {
  if (!id) return Promise.resolve(null);
  return safe(run(STORE_SESSIONS, 'readonly', st => st.get(id)), null)
    .then(s => s || null);
}

export function listSessions() {
  return safe(run(STORE_SESSIONS, 'readonly', st => st.getAll()), [])
    .then(rows => (rows || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
}

/**
 * Supprime une session, ses parties terminées ET ses parties interrompues.
 * Sans ce dernier point, les instantanés survivaient en orphelins : la partie
 * disparaissait de l'archive mais restait proposée à la reprise.
 */
export function deleteSession(id) {
  if (!id) return Promise.resolve(null);
  return safe(
    run(STORE_SESSIONS, 'readwrite', st => st.delete(id))
      .then(() => Promise.all([listParties(id), listResumes(id)]))
      .then(([parties, resumes]) => Promise.all([
        ...parties.map(p => deletePartie(p.id)),
        ...resumes.map(r => deleteResume(r.partieId)),
      ])),
    null
  );
}

export function putPartie(partie) {
  return safe(run(STORE_PARTIES, 'readwrite', st => st.put(partie)), null);
}

export function deletePartie(id) {
  return safe(run(STORE_PARTIES, 'readwrite', st => st.delete(id)), null);
}

export function listParties(sessionId) {
  return safe(
    run(STORE_PARTIES, 'readonly', st => st.index('sessionId').getAll(sessionId)),
    []
  ).then(rows => (rows || []).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)));
}

// --- Reprise d'une partie interrompue ---

export function putResume(snapshot) {
  return safe(run(STORE_RESUME, 'readwrite', st => st.put(snapshot)), null);
}

export function getResume(partieId) {
  if (!partieId) return Promise.resolve(null);
  return safe(run(STORE_RESUME, 'readonly', st => st.get(partieId)), null)
    .then(r => r || null);
}

/** Toutes les parties interrompues d'une session, la plus récente d'abord. */
export function listResumes(sessionId) {
  if (!sessionId) return Promise.resolve([]);
  return safe(
    run(STORE_RESUME, 'readonly', st => st.index('sessionId').getAll(sessionId)),
    []
  ).then(rows => (rows || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)));
}

export function deleteResume(partieId) {
  if (!partieId) return Promise.resolve(null);
  return safe(run(STORE_RESUME, 'readwrite', st => st.delete(partieId)), null);
}

/**
 * Remise à l'état d'usine de l'archive : vide les stores au lieu de détruire la
 * base.
 *
 * Détruire puis rouvrir pour réécrire, dans une page qui va se recharger, ouvrait
 * deux trous : `deleteDatabase` reste en attente indéfiniment si un autre onglet
 * tient la base, et la réouverture qui suit se met en file derrière cette
 * suppression en suspens — plus rien ne répond. Un `clear()` est une
 * transaction ordinaire : pas de sémantique de blocage, pas de réouverture.
 *
 * Les trois stores sont vidés dans UNE transaction : soit tout part, soit rien.
 * Un vidage partiel laisserait des parties orphelines sans leur session.
 *
 * @returns {Promise<boolean>} faux si l'archive n'a pas pu être vidée
 */
export function clearArchive({ keepModes = true } = {}) {
  const stores = keepModes
    ? [STORE_SESSIONS, STORE_PARTIES, STORE_RESUME]
    : [STORE_SESSIONS, STORE_PARTIES, STORE_RESUME, STORE_MODES];
  return safe(openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    for (const name of stores) tx.objectStore(name).clear();
    tx.oncomplete = () => resolve(true);
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  })), false);
}

// --- Modes de jeu ---

export function listModes() {
  return safe(run(STORE_MODES, 'readonly', st => st.getAll()), [])
    .then(rows => (rows || []).sort((a, b) => (a.order || 0) - (b.order || 0)));
}

export function putMode(mode) {
  return safe(run(STORE_MODES, 'readwrite', st => st.put(mode)), null);
}

export function deleteMode(id) {
  if (!id) return Promise.resolve(null);
  return safe(run(STORE_MODES, 'readwrite', st => st.delete(id)), null);
}
