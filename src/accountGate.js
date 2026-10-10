// src/accountGate.js — garde de lancement de partie (mode payant).
//
// Point d'entrée unique pour consommer un crédit AVANT de lancer une partie qui
// utilisera la clé serveur (canapé ou lobby). BYOK et cache-only passent sans
// compte. Sinon : non connecté → invite à se connecter ; plus de crédits → invite
// à acheter ; sinon → consomme un crédit et mémorise le game token.
import { getState, dispatch } from './state.js';
import { consumeGame, createCheckout, signInWithGoogle } from './account.js';
import { confirmDialog } from './components/dialog.js';

function toast(message, kind = 'error') {
  document.dispatchEvent(new CustomEvent('qc:toast', { detail: { message, kind } }));
}

/**
 * Rend `true` si la partie peut démarrer (crédit consommé), `false` sinon.
 * Peut rediriger vers Google ou Stripe.
 */
export async function ensureAccountForGame() {
  const { account, llm, settings } = getState();
  if (!account.gated || llm.apiKey || settings.cacheOnly) return true;

  if (!account.signedIn) {
    const go = await confirmDialog({
      title: 'Compte requis',
      message: 'Cette partie utilise les questions du serveur (aucune clé personnelle renseignée).\n\nConnectez-vous avec Google pour jouer.',
      confirmLabel: 'Se connecter avec Google',
    });
    if (go) signInWithGoogle();
    return false;
  }

  // Confirmation explicite : consommer un crédit n'est pas implicite.
  const total = (account.freeRemaining || 0) + (account.purchasedRemaining || 0);
  const go = await confirmDialog({
    title: 'Utiliser 1 crédit ?',
    message: `Cette partie consomme 1 crédit (${account.freeRemaining} offert, ${account.purchasedRemaining} acheté).\n\nIl vous en restera ${Math.max(0, total - 1)}.`,
    confirmLabel: 'Démarrer',
  });
  if (!go) return false;

  try {
    const data = await consumeGame();
    dispatch({ type: 'SET_ACCOUNT', patch: data });
    return true;
  } catch (err) {
    if (err?.code === 'NO_CREDITS') {
      const go = await confirmDialog({
        title: 'Plus de parties offertes',
        message: 'Vous avez épuisé vos parties offertes de ce mois.\n\nAchetez un pack de parties pour continuer.',
        confirmLabel: 'Acheter',
      });
      if (go) {
        try {
          const { url } = await createCheckout();
          window.location.href = url;
        } catch (err2) {
          toast(err2?.message || 'Paiement indisponible pour le moment.', 'error');
        }
      }
      return false;
    }
    toast(err?.message || 'Impossible de démarrer la partie.', 'error');
    return false;
  }
}
