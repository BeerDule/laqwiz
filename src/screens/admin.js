// screens/admin.js — page d'administration (réservée à ADMIN_USER_EMAIL).
//
// Liste les comptes et leurs crédits ; l'administrateur peut modifier le solde de
// crédits achetés de chaque compte. Le droit d'accès est re-vérifié par le serveur
// sur chaque endpoint /api/admin/* (le client ne fait qu'afficher ce qu'il reçoit).
import { getState, dispatch } from '../state.js';
import { fetchAdminUsers, setUserCredits } from '../account.js';

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
      <span class="admin-row__free">${u.freeRemaining} gratuite(s)</span>
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
          Comptes et crédits. Modifiez le solde « achetées » puis enregistrez ;
          les parties gratuites (${getState().account.freeGamesPerMonth}/mois) restent automatiques.
        </p>
        <div id="admin-list" class="admin-list"></div>
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

  loadUsers();

  teardown = () => {
    cleanup.abort();
    root = null;
  };
}

export function unmountAdmin() {
  if (teardown) { teardown(); teardown = null; }
  root = null;
}
