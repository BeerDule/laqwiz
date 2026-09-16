// components/dialog.js — confirmations et saisies natives à l'app.
//
// Remplace window.confirm / window.prompt : même contrat (un booléen, ou la
// chaîne saisie / null), mais rendu dans un <dialog> stylé par le thème au lieu
// de la fenêtre native du navigateur. Le dialogue vit dans la top layer — donc
// au-dessus de tous les écrans — et est retiré du DOM à la fermeture.
//
// Usage :
//   const ok = await confirmDialog({ title, message, danger });
//   const value = await promptDialog({ title, label, value, maxLength });

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Confirmation. Résout true si le MJ confirme, false sinon (Annuler / Échap).
 * `danger` colore le bouton de confirmation en rouge (action destructive).
 * `confirmText` : si fourni, la confirmation ne se débloque qu'après avoir tapé
 * exactement ce mot — pour les destructions irréversibles.
 */
export function confirmDialog({
  title = '',
  message = '',
  confirmLabel = 'Confirmer',
  cancelLabel = 'Annuler',
  danger = false,
  confirmText = null,
  confirmTextHint = '',
} = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';

    const input = confirmText ? `
      <label class="modal__field">
        <span class="modal__field-label">${escapeHtml(confirmTextHint || `Tapez « ${confirmText} » pour confirmer`)}</span>
        <input type="text" class="modal__input" autocomplete="off" spellcheck="false" />
      </label>` : '';

    dialog.innerHTML = `
      <form method="dialog" class="modal__card">
        ${title ? `<h2 class="modal__title">${escapeHtml(title)}</h2>` : ''}
        ${message ? `<p class="modal__message">${escapeHtml(message)}</p>` : ''}
        ${input}
        <div class="modal__actions">
          <button value="cancel" class="modal__btn" type="submit">${escapeHtml(cancelLabel)}</button>
          <button value="confirm" class="modal__btn ${danger ? 'modal__btn--danger' : 'modal__btn--primary'}" type="submit">${escapeHtml(confirmLabel)}</button>
        </div>
      </form>
    `;
    document.body.appendChild(dialog);

    const confirmBtn = dialog.querySelector('button[value="confirm"]');
    const inputEl = dialog.querySelector('.modal__input');

    if (inputEl) {
      const sync = () => { confirmBtn.disabled = inputEl.value.trim() !== confirmText; };
      inputEl.addEventListener('input', sync);
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && inputEl.value.trim() !== confirmText) e.preventDefault();
      });
      sync();
    }

    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'confirm');
      dialog.remove();
    }, { once: true });

    dialog.showModal();
    if (inputEl) inputEl.focus();
  });
}

/**
 * Saisie d'une ligne. Résout la chaîne saisie, ou null si annulé.
 * `required` désactive la confirmation tant que le champ est vide.
 */
export function promptDialog({
  title = '',
  label = '',
  value = '',
  maxLength = 0,
  confirmLabel = 'OK',
  cancelLabel = 'Annuler',
  required = true,
} = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';

    dialog.innerHTML = `
      <form method="dialog" class="modal__card">
        ${title ? `<h2 class="modal__title">${escapeHtml(title)}</h2>` : ''}
        <label class="modal__field">
          ${label ? `<span class="modal__field-label">${escapeHtml(label)}</span>` : ''}
          <input type="text" class="modal__input" autocomplete="off" spellcheck="false"
            ${maxLength ? `maxlength="${maxLength}"` : ''} />
        </label>
        <div class="modal__actions">
          <button value="cancel" class="modal__btn" type="submit">${escapeHtml(cancelLabel)}</button>
          <button value="confirm" class="modal__btn modal__btn--primary" type="submit">${escapeHtml(confirmLabel)}</button>
        </div>
      </form>
    `;
    document.body.appendChild(dialog);

    const inputEl = dialog.querySelector('.modal__input');
    const confirmBtn = dialog.querySelector('button[value="confirm"]');
    inputEl.value = value;

    const sync = () => { confirmBtn.disabled = required && !inputEl.value.trim(); };
    inputEl.addEventListener('input', sync);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && confirmBtn.disabled) e.preventDefault();
    });
    sync();

    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'confirm' ? inputEl.value : null);
      dialog.remove();
    }, { once: true });

    dialog.showModal();
    inputEl.focus();
    inputEl.select();
  });
}
