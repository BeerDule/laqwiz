// demo/state-test.mjs — valide l'échéance du chrono dans le store (zéro dépendance).
//
// `deadlineAt` est posé à SHOW_NEXT_QUESTION (source de vérité unique partagée
// entre game.js et room.js). On vérifie qu'une question avec chrono pose une
// échéance future, et qu'une question sans chrono n'en pose aucune.

globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
  clear() { this._d = {}; },
};
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
globalThis.indexedDB = undefined; // vérifie aussi le repli sans archive

const { getState, dispatch } = await import('../src/state.js');

const QUESTION = {
  question: 'Quelle est la capitale ?',
  options: [
    { key: 'A', text: 'Paris' }, { key: 'B', text: 'Londres' },
    { key: 'C', text: 'Berlin' }, { key: 'D', text: 'Madrid' },
  ],
  answer: 'A', funnyOption: 'B',
  explanation: 'Une explication suffisamment longue pour être valide.',
  difficulty: 'balanced', theme: 'Géographie',
};

function mountState(s) {
  s.session = { id: 's1', name: 'soirée', status: 'active' };
  s.partie = { id: 'p1', mancheIndex: 0, manchesTarget: 1, manchesWon: {}, manches: [] };
  s.players = [{ id: 'p1', name: 'Alice', emoji: '🦊', color: '#fff', score: 0 }];
  s.questions = [];
  s.currentIndex = -1;
  s.prefetchQueue = [QUESTION];
}

let passed = 0;
let failed = 0;
function check(cond, label, detail = '') {
  if (cond) { passed += 1; console.log(`✓ ${label}`); }
  else { failed += 1; console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// 1) Chrono activé : l'échéance est un futur proche.
{
  const s = getState();
  mountState(s);
  s.settings = { ...s.settings, timerEnabled: true, timePerQuestion: 30 };
  const before = Date.now();
  dispatch({ type: 'SHOW_NEXT_QUESTION' });
  const dl = getState().deadlineAt;
  check(
    typeof dl === 'number' && dl >= before + 29000 && dl <= before + 31000,
    'chrono actif : deadlineAt ≈ +30 s',
    `reçu ${dl} (avant ${before})`,
  );
}

// 2) Chrono désactivé : aucune échéance.
{
  const s = getState();
  mountState(s);
  s.settings = { ...s.settings, timerEnabled: false };
  dispatch({ type: 'SHOW_NEXT_QUESTION' });
  check(getState().deadlineAt === null, 'chrono inactif : deadlineAt null');
}

console.log(`\n${passed} test(s) OK, ${failed} échec(s).`);
process.exit(failed ? 1 : 0);
