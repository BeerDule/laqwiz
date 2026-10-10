// src/accountBadge.js — pastille « compte connecté » en haut à gauche.
//
// Affiche, quand un compte est connecté (mode payant), le nom du créateur et le
// nombre de parties restantes. Rendu par textContent : le nom vient de Google et
// ne doit jamais être injecté en HTML.
import { getState, subscribe } from './state.js';

const BADGE_ID = 'account-badge';
let lastSig = '';

function render(s) {
  const a = s.account;
  const show = a.gated && a.signedIn;
  const label = a.name || a.email || '';
  const left = (a.freeRemaining || 0) + (a.purchasedRemaining || 0);
  const sig = `${show ? 1 : 0}|${label}|${left}`;
  if (sig === lastSig) return;
  lastSig = sig;

  const node = document.getElementById(BADGE_ID);
  if (!node) return;
  if (!show) {
    node.hidden = true;
    return;
  }
  node.textContent = `👤 ${label} · ${left} partie${left > 1 ? 's' : ''} restante${left > 1 ? 's' : ''}`;
  node.hidden = false;
}

export function initAccountBadge() {
  subscribe(render);
  render(getState());
}
