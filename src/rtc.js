// rtc.js — transport WebRTC (RTCDataChannel) direct entre deux navigateurs.
//
// Primitive partagée host/joueur : `createDataPeer` ouvre (initiator) ou accepte
// (répondeur) une connexion directe et expose un canal de données fiable et
// ordonné — les défauts de RTCDataChannel, mêmes garanties que l'ancien
// WebSocket. La signalisation (offre / réponse / candidats ICE) remonte via
// `onSignal` : l'appelant la route sur son canal WebSocket.
//
// Zéro dépendance : API navigateur native. `RTCPeerConnection` est lu sur
// `globalThis` pour rester testable dans Node avec un bouchon.

export function createDataPeer({ initiator, iceServers, onSignal, onOpen, onMessage, onClose, onError }) {
  const pc = new globalThis.RTCPeerConnection({ iceServers: iceServers || [] });
  let channel = null;
  // Candidats ICE reçus avant `setRemoteDescription` : ils seraient rejetés.
  // On les met en file et on les rejoue une fois la description distante posée.
  let pendingCandidates = [];

  function flushCandidates() {
    for (const c of pendingCandidates) pc.addIceCandidate(c).catch(() => {});
    pendingCandidates = [];
  }

  function setupChannel(ch) {
    ch.onopen = () => onOpen();
    ch.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch { /* message non-JSON ignoré */ }
    };
    ch.onclose = () => onClose();
  }

  if (initiator) {
    channel = pc.createDataChannel('game');
    setupChannel(channel);
    pc.onicecandidate = (e) => { if (e.candidate) onSignal({ type: 'ice', candidate: e.candidate }); };
    pc.createOffer()
      .then((desc) => pc.setLocalDescription(desc).then(() => pc.localDescription))
      .then((desc) => onSignal({ type: 'offer', sdp: desc }))
      .catch((err) => onError?.(err));
  } else {
    pc.onicecandidate = (e) => { if (e.candidate) onSignal({ type: 'ice', candidate: e.candidate }); };
    pc.ondatachannel = (e) => { channel = e.channel; setupChannel(channel); };
  }

  return {
    /** Traite un message de signalisation reçu du pair (`offer` / `answer` / `ice`). */
    handleSignal(sig) {
      if (sig.type === 'offer') {
        pc.setRemoteDescription(sig.sdp)
          .then(() => pc.createAnswer())
          .then((desc) => pc.setLocalDescription(desc).then(() => pc.localDescription))
          .then((desc) => { flushCandidates(); onSignal({ type: 'answer', sdp: desc }); })
          .catch((err) => onError?.(err));
      } else if (sig.type === 'answer') {
        pc.setRemoteDescription(sig.sdp).then(flushCandidates).catch((err) => onError?.(err));
      } else if (sig.type === 'ice') {
        if (pc.remoteDescription) pc.addIceCandidate(sig.candidate).catch(() => {});
        else pendingCandidates.push(sig.candidate);
      }
    },
    /** Envoie un message sur le canal de données (no-op tant qu'il n'est pas ouvert). */
    send(data) {
      if (channel?.readyState === 'open') channel.send(JSON.stringify(data));
    },
    close() {
      try { pc.close(); } catch { /* déjà fermé */ }
    },
  };
}
