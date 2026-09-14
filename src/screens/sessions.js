// screens/sessions.js — sélecteur de sessions façon « level select ».
// Comme home.js, cet écran garde l'identité « île » quel que soit le thème.
import { getState, dispatch } from '../state.js';
import { listSessions, listParties, putSession, deleteSession } from '../db.js';

let teardown = null;
let root = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatDate(ts) {
  try {
    return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch { return ''; }
}

const SHELL = `
  <section class="arcade arcade--sessions screen" data-screen="sessions" aria-labelledby="sessions-title">
    <header class="arcade__bar">
      <button id="btn-back" class="arcade-btn arcade-btn--icon" aria-label="Retour au menu">‹</button>
      <h1 id="sessions-title">Sessions</h1>
      <button id="btn-create" class="arcade-btn arcade-btn--primary">Nouvelle session</button>
    </header>
    <div id="sessions-grid" class="arcade-grid" aria-live="polite">
      <p class="arcade-empty">Chargement de l'archive…</p>
    </div>
  </section>
`;

/** Médailles gagnées par joueur sur l'ensemble des parties de la session. */
function trophies(parties, players) {
  const byId = Object.fromEntries(players.map(p => [p.id, p]));
  const wins = {};
  for (const p of parties) {
    if (p.winnerId) wins[p.winnerId] = (wins[p.winnerId] || 0) + 1;
  }
  const rows = Object.entries(wins)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `
      <span class="arcade-trophy">
        <span class="arcade-avatar">${byId[id]?.emoji || '•'}</span>
        <span class="arcade-trophy__count">×${n}</span>
      </span>`);
  return rows.join('') || '<span class="arcade-card__muted">Aucune partie terminée</span>';
}

function sessionCard(session, parties) {
  const players = session.players || [];
  const isActive = session.status === 'active'
    && getState().session?.id === session.id;
  const finished = parties.filter(p => p.winnerId).length;

  return `
    <article class="arcade-card${isActive ? ' arcade-card--active' : ''}" data-session="${escapeHtml(session.id)}">
      <div class="arcade-card__head">
        <h2 class="arcade-card__name">${escapeHtml(session.name)}</h2>
        ${isActive ? '<span class="arcade-tag">en cours</span>' : ''}
      </div>
      <p class="arcade-card__date">${formatDate(session.createdAt)}</p>
      <div class="arcade-card__roster">
        ${players.map(p => `<span class="arcade-avatar" title="${escapeHtml(p.name)}">${p.emoji}</span>`).join('')
          || '<span class="arcade-card__muted">Aucun joueur</span>'}
      </div>
      <div class="arcade-card__stat">
        <span>${parties.length} partie${parties.length > 1 ? 's' : ''} · ${finished} terminée${finished > 1 ? 's' : ''}</span>
      </div>
      <div class="arcade-card__trophies">${trophies(parties, players)}</div>
      <div class="arcade-card__actions">
        ${isActive ? '' : '<button class="arcade-btn arcade-btn--primary" data-action="resume">Ouvrir</button>'}
        <button class="arcade-btn arcade-btn--small" data-action="rename">Renommer</button>
        <button class="arcade-btn arcade-btn--small arcade-btn--danger" data-action="delete">Supprimer</button>
      </div>
    </article>
  `;
}

async function refresh() {
  const grid = root?.querySelector('#sessions-grid');
  if (!grid) return;
  const sessions = await listSessions();
  if (!root) return; // écran démonté pendant la lecture
  if (!sessions.length) {
    grid.innerHTML = '<p class="arcade-empty">Aucune session pour l\'instant. Créez-en une pour commencer.</p>';
    return;
  }
  const parties = await Promise.all(sessions.map(s => listParties(s.id)));
  if (!root) return;
  grid.innerHTML = sessions.map((s, i) => sessionCard(s, parties[i])).join('');
}

export function renderSessions(rootEl) {
  unmountSessions();
  root = rootEl;
  root.innerHTML = SHELL;

  const cleanup = new AbortController();
  const { signal } = cleanup;

  root.querySelector('#btn-back').addEventListener('click', () => {
    dispatch({ type: 'GOTO_HOME' });
  }, { signal });

  root.querySelector('#btn-create').addEventListener('click', () => {
    dispatch({ type: 'NEW_SESSION' });
  }, { signal });

  root.querySelector('#sessions-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.closest('.arcade-card')?.dataset.session;
    if (!id) return;
    const session = (await listSessions()).find(s => s.id === id);
    if (!session || !root) return;

    if (btn.dataset.action === 'rename') {
      const name = window.prompt('Nom de la session', session.name);
      if (name && name.trim()) {
        const clean = name.trim().slice(0, 60);
        await putSession({ ...session, name: clean });
        if (getState().session?.id === id) {
          dispatch({ type: 'RENAME_SESSION', id, name: clean });
        }
        refresh();
      }
    } else if (btn.dataset.action === 'delete') {
      if (window.confirm(`Supprimer « ${session.name} » et ses parties ? Cette action est définitive.`)) {
        await deleteSession(id);
        refresh();
      }
    } else if (btn.dataset.action === 'resume') {
      dispatch({ type: 'RESUME_SESSION', session });
    }
  }, { signal });

  refresh();

  teardown = () => {
    cleanup.abort();
    root = null;
  };
}

export function unmountSessions() {
  if (teardown) { teardown(); teardown = null; }
  root = null;
}
