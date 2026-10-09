// demo/rtc-test.mjs — valide la machine à états WebRTC (zéro dépendance).
//
// `createDataPeer` s'appuie sur `RTCPeerConnection`, absent de Node : on injecte
// un bouchon minimal pour vérifier le séquencement offre → réponse → candidats
// → canal, sans navigateur ni framework.
//
// Usage : node demo/rtc-test.mjs

const instances = [];

class MockChannel {
  constructor() {
    this.readyState = 'connecting';
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
  }
  send(data) { this.sent.push(data); }
  open() { this.readyState = 'open'; this.onopen?.(); }
}

class MockRTC {
  constructor() {
    instances.push(this);
    this.localDescription = null;
    this.remoteDescription = null;
    this.addedCandidates = [];
    this.closed = false;
    this.onicecandidate = null;
    this.ondatachannel = null;
  }
  createDataChannel() { this.datachannel = new MockChannel(); return this.datachannel; }
  createOffer() { return Promise.resolve({ type: 'offer', sdp: 'offer-sdp' }); }
  createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'answer-sdp' }); }
  setLocalDescription(d) { this.localDescription = d; return Promise.resolve(); }
  setRemoteDescription(d) { this.remoteDescription = d; return Promise.resolve(); }
  addIceCandidate(c) { this.addedCandidates.push(c); return Promise.resolve(); }
  close() { this.closed = true; }
}
globalThis.RTCPeerConnection = MockRTC;

const { createDataPeer } = await import('../src/rtc.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
let passed = 0;
let failed = 0;
function check(cond, label, detail = '') {
  if (cond) { passed += 1; console.log(`✓ ${label}`); }
  else { failed += 1; console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// 1) L'initiateur crée le DataChannel et émet une offre.
{
  const signals = [];
  createDataPeer({ initiator: true, iceServers: [], onSignal: (s) => signals.push(s), onOpen: () => {}, onMessage: () => {}, onClose: () => {} });
  await tick(); await tick();
  check(signals.some(s => s.type === 'offer' && s.sdp?.sdp === 'offer-sdp'), 'initiateur : émet une offre');
  check(instances[0].datachannel instanceof MockChannel, 'initiateur : crée le DataChannel');
}

// 2) Le répondeur accepte l'offre et répond.
{
  const signals = [];
  const peer = createDataPeer({ initiator: false, iceServers: [], onSignal: (s) => signals.push(s), onOpen: () => {}, onMessage: () => {}, onClose: () => {} });
  peer.handleSignal({ type: 'offer', sdp: { type: 'offer', sdp: 'offer-sdp' } });
  await tick(); await tick(); await tick();
  check(signals.some(s => s.type === 'answer' && s.sdp?.sdp === 'answer-sdp'), 'répondeur : répond à l\'offre');
}

// 3) Candidats ICE reçus avant la description distante : mis en file puis rejoués.
{
  const signals = [];
  const peer = createDataPeer({ initiator: false, iceServers: [], onSignal: (s) => signals.push(s), onOpen: () => {}, onMessage: () => {}, onClose: () => {} });
  peer.handleSignal({ type: 'ice', candidate: { candidate: 'c1' } });
  peer.handleSignal({ type: 'offer', sdp: { type: 'offer', sdp: 'offer-sdp' } });
  await tick(); await tick(); await tick();
  const pc = instances[instances.length - 1];
  check(pc.addedCandidates.some(c => c.candidate === 'c1'), 'répondeur : candidat précoce rejoué après l\'offre', JSON.stringify(pc.addedCandidates));
}

// 4) send() n'émet que sur un canal ouvert, et onMessage décode le JSON.
{
  const received = [];
  const peer = createDataPeer({
    initiator: true, iceServers: [], onSignal: () => {},
    onOpen: () => {}, onMessage: (m) => received.push(m), onClose: () => {},
  });
  await tick(); await tick();
  const ch = instances[instances.length - 1].datachannel;
  peer.send({ hello: 'world' });
  check(ch.sent.length === 0, 'send() sur canal fermé : no-op');
  ch.open();
  peer.send({ hello: 'world' });
  check(ch.sent.length === 1 && ch.sent[0] === '{"hello":"world"}', 'send() sur canal ouvert : émet le JSON');
  ch.onmessage({ data: '{"type":"game.answer","payload":{"optionKey":"A"}}' });
  check(received.length === 1 && received[0].payload.optionKey === 'A', 'onMessage : décode et remonte le message');
}

// 5) onClose remonte quand le canal se ferme (déclencheur de la reprise).
{
  let closed = false;
  const peer = createDataPeer({
    initiator: true, iceServers: [], onSignal: () => {},
    onOpen: () => {}, onMessage: () => {}, onClose: () => { closed = true; },
  });
  await tick(); await tick();
  const ch = instances[instances.length - 1].datachannel;
  ch.onclose(); // le navigateur émet onclose quand le canal tombe
  check(closed, 'onClose : remonte quand le canal se ferme');
}

console.log(`\n${passed} test(s) OK, ${failed} échec(s).`);
process.exit(failed ? 1 : 0);
