// src/account.js — compte Google + crédits (mode payant), côté client.
//
// Le jeton de SESSION vit dans un cookie HttpOnly posé par le serveur : ce module
// ne le manipule jamais. Le GAME TOKEN, lui, est rendu par POST /api/account/games
// et doit survivre à un rechargement (F5) pour que la partie reprise continue
// d'interroger le LLM — d'où sa persistance en localStorage (comme hostToken).
import { STORAGE_KEYS } from './constants.js';

let gameToken = null; // module-level, comme hostToken dans room.js

function readStoredToken() {
  try { return localStorage.getItem(STORAGE_KEYS.gameToken) || null; } catch { return null; }
}

export function setGameToken(token) {
  gameToken = token || null;
  try {
    if (token) localStorage.setItem(STORAGE_KEYS.gameToken, token);
    else localStorage.removeItem(STORAGE_KEYS.gameToken);
  } catch { /* navigation privée / quota */ }
}

export function getGameToken() {
  return gameToken || readStoredToken();
}

export class AccountError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'AccountError';
    this.code = code; // AUTH_REQUIRED | NO_CREDITS | STRIPE_* | HTTP_*
    this.status = status;
  }
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data?.error?.code || `HTTP_${res.status}`;
    const message = data?.error?.message || `Erreur ${res.status}`;
    throw new AccountError(code, message, res.status);
  }
  return data;
}

/** État du compte et du serveur (gated, crédits). */
export function fetchAccountMe() {
  return requestJson('/api/account/me');
}

/** Consomme un crédit et mémorise le game token rendu. */
export async function consumeGame() {
  const data = await requestJson('/api/account/games', { method: 'POST' });
  setGameToken(data.gameToken);
  return data;
}

/** Libère le game token en fin de partie (best-effort). */
export async function releaseGame() {
  const token = getGameToken();
  setGameToken(null);
  if (!token) return;
  try {
    await requestJson('/api/account/games/end', {
      method: 'POST',
      body: JSON.stringify({ gameToken: token }),
    });
  } catch { /* la partie est finie de toute façon */ }
}

/** Crée une session de paiement Stripe et renvoie son URL. */
export function createCheckout() {
  return requestJson('/api/account/checkout', { method: 'POST' });
}

/** Liste des comptes (réservé à l'administrateur). */
export function fetchAdminUsers() {
  return requestJson('/api/admin/users');
}

/** Fixe les crédits achetés d'un compte (réservé à l'administrateur). */
export function setUserCredits(id, credits) {
  return requestJson(`/api/admin/users/${id}/credits`, {
    method: 'POST',
    body: JSON.stringify({ credits }),
  });
}

/** Thèmes en cache (réservé à l'administrateur). */
export function fetchCacheThemes() {
  return requestJson('/api/admin/themes');
}

/** Supprime un thème du cache (réservé à l'administrateur). */
export function deleteCacheTheme(theme) {
  return requestJson('/api/admin/themes/delete', {
    method: 'POST',
    body: JSON.stringify({ theme }),
  });
}

export async function signOut() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* serveur injoignable */ }
}

/** Redirige vers le flux OAuth Google côté serveur. */
export function signInWithGoogle() {
  window.location.href = '/api/auth/google';
}
