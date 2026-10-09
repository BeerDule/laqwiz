// connIndicator.js — indicateur d'état de connexion WebSocket (host et joueur).
//
// Un point coloré + un libellé (« Ping 42 ms », « Reconnexion… », « Hors ligne »)
// rafraîchi chaque seconde. Le consommateur fournit `getInfo()` qui renvoie
// `{ state, rttMs }` où `state` ∈ connecting | connected | reconnecting | offline,
// et `rttMs` est la dernière latence aller-retour mesurée (null si jamais mesurée).

export function connIndicatorHtml() {
  return '<span id="conn-indicator" class="conn-indicator" data-state="offline" role="status" aria-live="off"></span>';
}

function connStatus(info) {
  if (info.state === 'offline') return { state: 'offline', label: 'Hors ligne' };
  if (info.state === 'connecting' || info.state === 'reconnecting') return { state: 'reconnecting', label: 'Reconnexion…' };
  if (typeof info.rttMs === 'number') return { state: 'connected', label: `Ping ${info.rttMs} ms` };
  return { state: 'connected', label: 'Connecté' };
}

/**
 * Branche l'indicateur. Retourne une fonction de nettoyage ; si `signal` est
 * fourni (AbortSignal), l'intervalle est aussi coupé à l'abort.
 */
export function wireConnIndicator(root, getInfo, signal) {
  const el = root.querySelector('#conn-indicator');
  if (!el) return () => {};
  const tick = () => {
    const { state, label } = connStatus(getInfo());
    if (el.dataset.state !== state) el.dataset.state = state;
    if (el.textContent !== label) el.textContent = label;
  };
  tick();
  const id = setInterval(tick, 1000);
  const cleanup = () => clearInterval(id);
  if (signal) signal.addEventListener('abort', cleanup, { once: true });
  return cleanup;
}
