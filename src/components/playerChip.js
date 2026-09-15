// components/playerChip.js — pastille de joueur avec son nom en popover.
//
// Le nom des joueurs apparaissait de trois façons différentes selon l'écran :
// un popover CSS sur les pastilles de réponse, un `title` natif sur les avatars
// des menus, un `aria-label` ailleurs. Trois rendus, trois délais d'apparition,
// et un `title` que les lecteurs d'écran annoncent de façon inégale.
//
// Ce module rend le même balisage partout. Le popover est porté par
// `data-tooltip` et stylé par `.player-chip` dans components.css.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * @param {object} player   { emoji, name }
 * @param {object} [options]
 * @param {string} [options.as='span']    balise : 'span' ou 'button'
 * @param {string} [options.className]    classes additionnelles
 * @param {object} [options.attrs]        attributs bruts ({ 'data-player': id })
 * @param {string} [options.suffix]       texte affiché après l'emoji (un score…)
 * @returns {string} HTML
 */
export function playerChip(player, { as = 'span', className = '', attrs = {}, suffix = '' } = {}) {
  const name = (player?.name || '').trim() || 'Joueur';
  const emoji = player?.emoji || '•';
  const extra = Object.entries(attrs)
    .map(([k, v]) => `${k}="${escapeHtml(v)}"`)
    .join(' ');
  // aria-label plutôt que `title` : le nom est déjà visible au survol via le
  // popover, et un `title` en plus le ferait annoncer deux fois.
  const cls = `player-chip ${className}`.trim();
  const type = as === 'button' ? 'type="button"' : '';
  const tail = suffix ? `<span class="player-chip__suffix">${escapeHtml(suffix)}</span>` : '';
  return `<${as} class="${cls}" data-tooltip="${escapeHtml(name)}" `
    + `aria-label="${escapeHtml(name)}" ${type} ${extra}>`
    + `<span aria-hidden="true">${emoji}</span>${tail}</${as}>`;
}

/** Suite de pastilles, pour un roster. */
export function playerChips(players, options) {
  return (players || []).map(p => playerChip(p, options)).join('');
}
