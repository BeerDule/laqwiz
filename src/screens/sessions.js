// screens/sessions.js — sélecteur de sessions façon « level select ».
// Comme home.js, cet écran garde l'identité « île » quel que soit le thème.
import { getState, dispatch } from '../state.js';
import { listSessions, listParties, deleteSession, listResumes } from '../db.js';
import { playerChip, playerChips } from '../components/playerChip.js';

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
        ${playerChip(byId[id] || { emoji: '•', name: 'Inconnu' }, { className: 'arcade-avatar' })}
        <span class="arcade-trophy__count">×${n}</span>
      </span>`);
  return rows.join('') || '<span class="arcade-card__muted">Aucune partie terminée</span>';
}

/** Une ligne décrivant la partie interrompue d'une session, s'il y en a une. */
function resumeLine(snapshots) {
  const n = (snapshots || []).length;
  if (!n) return '';
  const snapshot = snapshots[0];
  const manche = (snapshot.partie.mancheIndex ?? 0) + 1;
  const total = snapshot.partie.manchesTarget ?? '?';
  const scores = (snapshot.players || []).map(p => `${p.emoji} ${p.score ?? 0}`).join(' · ');
  return `
    <p class="arcade-card__resume">
      <span class="arcade-tag arcade-tag--resume">en cours</span>
      ${n > 1 ? `${n} parties interrompues · ` : ''}Manche ${manche}/${total}${scores ? ` · ${escapeHtml(scores)}` : ''}
    </p>`;
}

function sessionCard(session, parties, snapshots) {
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
        ${playerChips(players, { className: 'arcade-avatar' })
          || '<span class="arcade-card__muted">Aucun joueur</span>'}
      </div>
      <div class="arcade-card__stat">
        <span>${parties.length} partie${parties.length > 1 ? 's' : ''} · ${finished} terminée${finished > 1 ? 's' : ''}</span>
      </div>
      <div class="arcade-card__trophies">${trophies(parties, players)}</div>
      ${resumeLine(snapshots)}
      <div class="arcade-card__actions">
        ${snapshots.length ? '<button class="arcade-btn arcade-btn--primary" data-action="resume-partie">Reprendre la partie</button>' : ''}
        <!-- « Ouvrir » reste proposé sur la session courante : c'est le chemin
             pour revenir à ses réglages sans passer par le menu. -->
        <button class="arcade-btn${snapshots.length ? '' : ' arcade-btn--primary'}" data-action="resume">Ouvrir</button>
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
  const [parties, resumes] = await Promise.all([
    Promise.all(sessions.map(s => listParties(s.id))),
    Promise.all(sessions.map(s => listResumes(s.id))),
  ]);
  if (!root) return;
  grid.innerHTML = sessions.map((s, i) => sessionCard(s, parties[i], resumes[i])).join('');
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

    if (btn.dataset.action === 'delete') {
      if (window.confirm(`Supprimer « ${session.name} » et ses parties ? Cette action est définitive.`)) {
        await deleteSession(id);
        refresh();
      }
    } else if (btn.dataset.action === 'resume') {
      dispatch({ type: 'RESUME_SESSION', session });
    } else if (btn.dataset.action === 'resume-partie') {
      // Deux temps, et l'ordre compte : RESUME_SESSION vide `resumable` et
      // installe le roster de CETTE session. Reprendre la partie avant aurait
      // mélangé deux sessions — le garde-fou de RESUME_PARTIE la rejetterait.
      const snaps = await listResumes(id);
      if (!snaps.length) { refresh(); return; }
      dispatch({ type: 'RESUME_SESSION', session });
      dispatch({ type: 'SET_RESUMABLES', snapshots: snaps });
      // Plusieurs parties interrompues : on ouvre la session et on laisse le MJ
      // choisir dans l'écran de réglages plutôt que d'en imposer une.
      if (snaps.length === 1) dispatch({ type: 'RESUME_PARTIE', snapshot: snaps[0] });
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
