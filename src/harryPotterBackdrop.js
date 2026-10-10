// harryPotterBackdrop.js — fond animé du thème Harry Potter, en <canvas>.
//
// Même principe que mechaBackdrop.js / bitnikBackdrop.js : module autonome qui
// s'allume et s'éteint seul en observant `data-color-theme`, ignoré de
// themeSwitcher.js.
//
// La Grande Salle la nuit : des bougies flottantes qui dérivent lentement vers
// le plafond étoilé, et une poussière d'étoiles qui scintille en fondu. Tout
// est tracé à faible opacité : du texte nu passe devant.
//
// Garde-fous (identiques aux autres fonds) : rien ne clignote (WCAG 2.3.1),
// 30 i/s au plus, pause onglet caché, image fixe en mouvement réduit.

const THEME = 'harry-potter';
const FRAME_MS = 1000 / 30;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let canvas = null;
let ctx = null;
let raf = 0;
let last = 0;
let scene = null;

/** PRNG à graine : la même scène d'un redimensionnement à l'autre. */
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildScene(w, h, dpr) {
  const rand = mulberry32(1997); // « Harry Potter à l'école des sorciers », 1997

  // Bougies flottantes : une flamme chaude qui dérive vers le plafond.
  const candleCount = Math.max(8, Math.min(16, Math.floor(w / (130 * dpr))));
  const candles = Array.from({ length: candleCount }, () => ({
    x: 0.06 + rand() * 0.88,
    y: 0.05 + rand() * 0.9,
    core: (1.4 + rand() * 1.6) * dpr,
    halo: (14 + rand() * 22) * dpr,
    speed: (8 + rand() * 14) * dpr,      // px/s vers le haut
    sway: (10 + rand() * 22) * dpr,      // amplitude du balancement
    swaySpeed: 0.12 + rand() * 0.2,      // rad/s
    phase: rand() * Math.PI * 2,
    intensity: 0.6 + rand() * 0.4,
  }));

  // Poussière d'étoiles : le plafond enchanté scintille en fondu.
  const starCount = Math.max(24, Math.floor(w / (40 * dpr)));
  const stars = Array.from({ length: starCount }, () => ({
    x: rand() * w,
    y: rand() * h,
    size: (0.8 + rand() * 1.4) * dpr,
    twinkle: 0.4 + rand() * 1.2,         // rad/s
    phase: rand() * Math.PI * 2,
    warm: rand() < 0.7,                  // or chaud ou argent froid
  }));

  return { w, h, dpr, candles, stars };
}

function drawStars(t) {
  for (const s of scene.stars) {
    const a = (0.5 + 0.5 * Math.sin(t * s.twinkle + s.phase)) * 0.5;
    ctx.fillStyle = s.warm
      ? `rgba(246, 204, 102, ${a.toFixed(3)})`
      : `rgba(232, 226, 255, ${(a * 0.7).toFixed(3)})`;
    ctx.fillRect(s.x, s.y, s.size, s.size);
  }
}

function drawCandles(t) {
  const { w, h, dpr } = scene;
  for (const c of scene.candles) {
    // Défilement vers le haut, avec retour sous le bord bas.
    const span = h + 120 * dpr;
    const y = h + 60 * dpr - ((c.y * span + t * c.speed) % span);
    const x = c.x * w + Math.sin(t * c.swaySpeed + c.phase) * c.sway;

    // Halo chaud
    const halo = ctx.createRadialGradient(x, y, 0, x, y, c.halo);
    halo.addColorStop(0, `rgba(246, 204, 102, ${(0.16 * c.intensity).toFixed(3)})`);
    halo.addColorStop(0.55, `rgba(226, 176, 74, ${(0.06 * c.intensity).toFixed(3)})`);
    halo.addColorStop(1, 'rgba(226, 176, 74, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(x - c.halo, y - c.halo, c.halo * 2, c.halo * 2);

    // Flamme
    ctx.fillStyle = `rgba(255, 232, 160, ${(0.55 * c.intensity).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, c.core, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHud() {
  const { w, h, dpr } = scene;
  const m = 16 * dpr;
  ctx.font = `${10 * dpr}px 'Courier New', monospace`;
  ctx.fillStyle = 'rgba(226, 176, 74, 0.3)';
  ctx.textAlign = 'left';
  ctx.fillText('HOGWARTS · GRANDE SALLE', m, m + 14 * dpr);
  ctx.textAlign = 'right';
  ctx.fillText('LUMOS MAXIMA', w - m, m + 14 * dpr);
}

function draw(t) {
  ctx.clearRect(0, 0, scene.w, scene.h);
  drawStars(t);
  drawCandles(t);
  drawHud();
}

function resize() {
  if (!canvas) return;
  // Petits écrans : densité 1, le processeur graphique a déjà fort à faire
  const cap = window.innerWidth < 768 ? 1 : 1.5;
  const dpr = Math.min(window.devicePixelRatio || 1, cap);
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  canvas.width = w;
  canvas.height = h;
  scene = buildScene(w, h, dpr);
  if (reduceMotion.matches) draw(0);
}

function loop(now) {
  raf = requestAnimationFrame(loop);
  if (now - last < FRAME_MS) return;
  last = now;
  draw(now / 1000);
}

function play() {
  cancelAnimationFrame(raf);
  raf = 0;
  if (!canvas) return;
  if (reduceMotion.matches || document.hidden) {
    if (reduceMotion.matches) draw(0);
    return;
  }
  raf = requestAnimationFrame(loop);
}

function start() {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.id = 'harrypotter-backdrop';
  canvas.setAttribute('aria-hidden', 'true');
  ctx = canvas.getContext('2d');
  document.body.prepend(canvas);
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', play);
  reduceMotion.addEventListener('change', play);
  resize();
  play();
}

function stop() {
  if (!canvas) return;
  cancelAnimationFrame(raf);
  raf = 0;
  window.removeEventListener('resize', resize);
  document.removeEventListener('visibilitychange', play);
  reduceMotion.removeEventListener('change', play);
  canvas.remove();
  canvas = null;
  ctx = null;
  scene = null;
}

export function initHarryPotterBackdrop() {
  const root = document.documentElement;
  const sync = () => (root.dataset.colorTheme === THEME ? start() : stop());
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-color-theme'] });
  sync();
}