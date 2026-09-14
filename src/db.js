// db.js — archive IndexedDB (sessions et parties jouées).
//
// Répartition volontaire avec storage.js : le petit état chaud (roster,
// réglages, thème) reste en localStorage car main.js l'hydrate de façon
// synchrone avant le premier rendu. Seule l'archive, qui grossit sans limite,
// vit ici — sa lecture asynchrone ne bloque pas le démarrage.

const DB_NAME = 'quizz-canape';
const DB_VERSION = 1;
const STORE_SESSIONS = 'sessions';
const STORE_PARTIES = 'parties';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB indisponible'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
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

export function deleteSession(id) {
  return safe(
    run(STORE_SESSIONS, 'readwrite', st => st.delete(id)).then(() => listParties(id))
      .then(parties => Promise.all(parties.map(p => deletePartie(p.id)))),
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
