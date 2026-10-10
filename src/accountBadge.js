// src/accountBadge.js — compte connecté, dans la barre de navigation.
//
// Affiche, à côté de « Réglages », l'utilisateur connecté et son nombre de
// parties restantes : <icône> <nom> <crédits>. Rendu par textContent (le nom
// vient de Google, jamais injecté en HTML).
import { getState, subscribe } from './state.js';

const ROOT_ID = 'app-nav-account';
let lastSig = '';

function render(s) {
  const a = s.account;
  const show = a.gated && a.signedIn;
  const label = a.name || a.email || '';
  const left = (a.freeRemaining || 0) + (a.purchasedRemaining || 0);
  const sig = `${show ? 1 : 0}|${label}|${left}`;
  if (sig === lastSig) return;
  lastSig = sig;

  const node = document.getElementById(ROOT_ID);
  if (!node) return;
  if (!show) {
    node.hidden = true;
    return;
  }
  node.querySelector('.app-nav__account-name').textContent = label;
  node.querySelector('.app-nav__account-credits').textContent = String(left);
  node.hidden = false;
}

export function initAccountBadge() {
  subscribe(render);
  render(getState());
}
