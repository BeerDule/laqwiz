// screens/admin.js — page d'administration (réservée à ADMIN_USER_EMAIL).
//
// Liste les comptes et leurs crédits (modifiables), et les thèmes du cache de
// questions (supprimables). Le droit d'accès est re-vérifié par le serveur sur
// chaque endpoint /api/admin/* (le client ne fait qu'afficher ce qu'il reçoit).
import { getState, dispatch } from '../state.js';
import { fetchAdminUsers, setUserCredits, fetchCacheThemes, deleteCacheTheme } from '../account.js';
import { confirmDialog } from '../components/dialog.js';

let teardown = null;
let root = null;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function dispatchToast(message, kind = 'info') {
  document.dispatchEvent(new CustomEvent('qc:toast', { detail: { message, kind } }));
}

function userRow(u) {
  return `
    <div class="admin-row" data-id="${u.id}">
      <div class="admin-row__identity">
        <strong class="admin-row__email">${escapeHtml(u.email)}</strong>
        <span class="admin-row__name">${escapeHtml(u.name || '')}</span>
      </div>
      <span class="admin-row__free">${u.freeRemaining} offert</span>
      <label class="admin-row__field">
        <span>Achetées</span>
        <input type="number" class="admin-row__input" min="0" step="1" inputmode="numeric" value="${u.purchasedRemaining}" />
      </label>
      <button type="button" class="button button--small admin-row__save">Enregistrer</button>
    </div>`;
}

async function loadUsers() {
  const list = root.querySelector('#admin-list');
  list.textContent = 'Chargement…';
  try {
    const { users } = await fetchAdminUsers();
    list.innerHTML = users.length
      ? users.map(userRow).join('')
      : '<p class="llm-note">Aucun compte pour l\'instant.</p>';
  } catch (err) {
    list.textContent = err?.message || 'Impossible de charger la liste des comptes.';
  }
}

async function saveCredits(row, btn) {
  const id = Number(row.dataset.id);
  const input = row.querySelector('.admin-row__input');
  const credits = Number(input.value);
  if (!Number.isInteger(credits) || credits < 0) {
    dispatchToast('Nombre de crédits invalide.', 'error');
    return;
  }
  btn.disabled = true;
  try {
    await setUserCredits(id, credits);
    dispatchToast('Crédits mis à jour.', 'info');
  } catch (err) {
    dispatchToast(err?.message || 'Impossible d\'enregistrer.', 'error');
  } finally {
    btn.disabled = false;
  }
}

function themeRow(t) {
  const total = t.easy + t.medium + t.hard;
  return `
    <div class="admin-row" data-theme="${escapeHtml(t.theme)}">
      <div class="admin-row__identity">
        <strong class="admin-row__email">${escapeHtml(t.theme)}</strong>
        <span class="admin-row__name">${total} question(s)</span>
      </div>
      <span class="admin-row__free">${t.easy} facile · ${t.medium} moyen · ${t.hard} difficile</span>
      <button type="button" class="button button--danger admin-row__delete-theme">Supprimer</button>
    </div>`;
}

async function loadThemes() {
  const list = root.querySelector('#admin-themes');
  list.textContent = 'Chargement…';
  try {
    const { themes } = await fetchCacheThemes();
    list.innerHTML = themes.length
      ? themes.map(themeRow).join('')
      : '<p class="llm-note">Aucun thème en cache.</p>';
  } catch (err) {
    list.textContent = err?.message || 'Impossible de charger les thèmes.';
  }
}

async function deleteThemeRow(row, btn) {
  const theme = row.dataset.theme;
  if (!await confirmDialog({
    title: 'Supprimer le thème ?',
    message: `Supprimer « ${theme} » et toutes ses questions du cache ?`,
    confirmLabel: 'Supprimer',
    danger: true,
  })) return;
  btn.disabled = true;
  try {
    await deleteCacheTheme(theme);
    dispatchToast('Thème supprimé du cache.', 'info');
    loadThemes();
  } catch (err) {
    dispatchToast(err?.message || 'Impossible de supprimer.', 'error');
    btn.disabled = false;
  }
}

export function renderAdmin(rootEl) {
  unmountAdmin();
  root = rootEl;
  root.innerHTML = `
    <section class="arcade arcade--setup screen" data-screen="admin" aria-labelledby="admin-title">
      <header class="arcade__bar">
        <button id="btn-back" class="arcade-btn arcade-btn--icon" type="button" aria-label="Retour aux paramètres">‹</button>
        <h1 id="admin-title">Administration</h1>
      </header>
      <div class="panel">
        <p class="llm-note">
          Comptes et crédits. Modifiez le solde « acheté » puis enregistrez ;
          les parties offertes (${getState().account.freeGamesPerMonth}/mois) restent automatiques.
        </p>
        <div id="admin-list" class="admin-list"></div>
      </div>
      <div class="panel">
        <p class="llm-note">
          Cache de questions. Supprimer un thème retire toutes ses questions du pool.
        </p>
        <div id="admin-themes" class="admin-list"></div>
      </div>
    </section>`;

  const cleanup = new AbortController();
  const { signal } = cleanup;

  root.querySelector('#btn-back').addEventListener('click', () => {
    dispatch({ type: 'GOTO_SETTINGS' });
  }, { signal });

  root.querySelector('#admin-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.admin-row__save');
    if (!btn) return;
    saveCredits(btn.closest('.admin-row'), btn);
  }, { signal });

  root.querySelector('#admin-themes').addEventListener('click', (e) => {
    const btn = e.target.closest('.admin-row__delete-theme');
    if (!btn) return;
    deleteThemeRow(btn.closest('.admin-row'), btn);
  }, { signal });

  loadUsers();
  loadThemes();

  teardown = () => {
    cleanup.abort();
    root = null;
  };
}

export function unmountAdmin() {
  if (teardown) { teardown(); teardown = null; }
  root = null;
}
