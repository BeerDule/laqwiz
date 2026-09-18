// bitnikBackdrop.js — fond animé du thème Neo-Bitnik, dessiné dans un <canvas>.
//
// Même principe que mechaBackdrop.js : un module autonome qui s'allume et
// s'éteint seul en observant `data-color-theme`, ignoré de themeSwitcher.js.
// Tout est monochrome, à faible opacité : du texte nu passe devant.
//
// Motifs beatnik : réglure de la machine à écrire, pluie de lettres (le
// manuscrit continu de Kerouac), ronds de café, jazz, mots de la Beat
// Generation, une ligne tapée en direct, marées d'encre, marques de coupe.
//
// Garde-fous (identiques au Mecha) : rien ne clignote (WCAG 2.3.1), 30 i/s au
// plus, pause onglet caché, image fixe en mouvement réduit.

const THEME = 'neo-bitnik';
const FRAME_MS = 1000 / 30;
const GLYPHS = 'abcdefghijklmnopqrstuvwxyz ,.;:';
const WORDS = ['beat', 'howl', 'cool', 'dig', 'far out', 'on the road', 'bop', 'swing', 'jive', 'go', 'gone', 'groove'];
// Fragments de la Beat Generation, tapés à la machine, qui défilent.
const TYPE_LINES = [
  'the only people for me are the mad ones',
  'mad to live, mad to talk',
  'burn, burn, burn like roman candles',
  'first thought, best thought',
  'i saw the best minds of my generation',
  'dig it, man',
];
const INK = '234, 231, 226'; // encre du thème (blanc cassé #eae7e2)

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
  const rand = mulberry32(1957); // On the Road, 1957

  const rings = Array.from({ length: 5 }, () => ({
    x: (0.08 + rand() * 0.84) * w,
    y: (0.08 + rand() * 0.84) * h,
    r: (18 + rand() * 26) * dpr,
    phase: rand() * Math.PI * 2,
    period: 14 + rand() * 22,
    wobble: 0.4 + rand() * 0.8,
  }));

  const cols = [];
  const nCols = Math.max(4, Math.floor(w / (140 * dpr)));
  for (let i = 0; i < nCols; i++) {
    cols.push({
      x: (0.02 + rand() * 0.96) * w,
      offset: rand() * h,
      speed: (14 + rand() * 22) * dpr,
      seed: Math.floor(rand() * 1000),
    });
  }

  const words = WORDS.map((word) => ({
    word,
    x: 0.1 + rand() * 0.8,
    y: 0.1 + rand() * 0.8,
    speed: (6 + rand() * 10) * dpr,
    phase: rand() * Math.PI * 2,
  }));

  const notes = Array.from({ length: 6 }, (_, i) => ({
    x: 0.05 + rand() * 0.9,
    glyph: i % 2 ? '\u266b' : '\u266a',
    speed: (10 + rand() * 14) * dpr,
    offset: rand() * h,
    phase: rand() * Math.PI * 2,
  }));

  const typewriter = { y: h * (0.6 + rand() * 0.2) };

  return { w, h, dpr, rings, cols, words, notes, typewriter };
}

function drawRuled() {
  const { w, h, dpr } = scene;
  const gap = 34 * dpr;
  const margin = 46 * dpr;
  ctx.strokeStyle = `rgba(${INK}, 0.024)`;
  ctx.lineWidth = dpr;
  ctx.beginPath();
  for (let y = gap; y < h; y += gap) {
    ctx.moveTo(margin, y);
    ctx.lineTo(w - margin * 0.4, y);
  }
  ctx.stroke();
  ctx.strokeStyle = `rgba(${INK}, 0.05)`;
  ctx.beginPath();
  ctx.moveTo(margin, 0);
  ctx.lineTo(margin, h);
  ctx.stroke();
}

function drawRings(t) {
  for (const ring of scene.rings) {
    const k = ((t / ring.period) + ring.phase) % 1;
    const alpha = 0.07 * Math.sin(k * Math.PI);
    if (alpha <= 0.002) continue;
    const r = ring.r * (0.6 + k * 1.4);
    ctx.strokeStyle = `rgba(${INK}, ${alpha.toFixed(3)})`;
    ctx.lineWidth = (1.2 * scene.dpr) * (1 - k * 0.5);
    ctx.beginPath();
    ctx.ellipse(ring.x, ring.y, r, r * ring.wobble, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawColumns(t) {
  const { w, h, dpr } = scene;
  ctx.textAlign = 'left';
  const size = 13 * dpr;
  ctx.font = `${size}px monospace`;
  const tick = Math.floor(t * 1000 / FRAME_MS);
  for (const col of scene.cols) {
    const y0 = (col.offset + t * col.speed) % h;
    for (let k = 0; k < 12; k++) {
      const y = y0 - k * (size * 1.25);
      if (y < -size || y > h) continue;
      const a = 0.09 * (1 - k / 12);
      const g = GLYPHS[(col.seed + k * 7 + (k % 5 === 0 ? tick : 0)) % GLYPHS.length];
      ctx.fillStyle = `rgba(${INK}, ${a.toFixed(3)})`;
      ctx.fillText(g, col.x, y);
    }
  }
}

function drawTypewriter(t) {
  const { dpr } = scene;
  const margin = 46 * dpr;
  const size = 14 * dpr;
  const charsPerSec = 13;
  ctx.font = `${size}px monospace`;
  ctx.textAlign = 'left';
  // Une ligne de la Beat Generation, tapée en direct, puis on repart.
  const lineDur = 22;
  const idx = Math.floor(t / lineDur) % TYPE_LINES.length;
  const line = TYPE_LINES[idx];
  const local = t % lineDur;
  const typeTime = line.length / charsPerSec;
  const typed = line.slice(0, Math.floor(local * charsPerSec));
  ctx.fillStyle = `rgba(${INK}, 0.055)`;
  ctx.fillText(typed, margin, scene.typewriter.y);
  if (local < typeTime) {
    const cx = margin + (typed ? ctx.measureText(typed).width : 0);
    const a = 0.18 + 0.10 * Math.sin(t * 2.2);
    ctx.fillStyle = `rgba(${INK}, ${a.toFixed(3)})`;
    ctx.fillText('\u25ae', cx, scene.typewriter.y);
  }
}

function drawNotes(t) {
  const { w, h, dpr } = scene;
  ctx.textAlign = 'center';
  ctx.font = `${13 * dpr}px sans-serif`;
  for (const nt of scene.notes) {
    const y = h - ((t * nt.speed + nt.offset) % (h + 40 * dpr)) + 20 * dpr;
    const a = 0.06 * (0.6 + 0.4 * Math.sin(t * 0.7 + nt.phase));
    ctx.fillStyle = `rgba(${INK}, ${a.toFixed(3)})`;
    ctx.fillText(nt.glyph, nt.x * w, y);
  }
}

function drawWords(t) {
  const { w, h, dpr } = scene;
  ctx.textAlign = 'center';
  ctx.font = `italic ${15 * dpr}px monospace`;
  for (const wd of scene.words) {
    const y = (wd.y * h + t * wd.speed) % (h + 60 * dpr) - 30 * dpr;
    const alpha = 0.075 * (0.6 + 0.4 * Math.sin(t * 0.5 + wd.phase));
    ctx.fillStyle = `rgba(${INK}, ${alpha.toFixed(3)})`;
    ctx.fillText(wd.word, wd.x * w, y);
  }
}

function drawWash(t) {
  const { w, h, dpr } = scene;
  const y = ((t / 26) % 1) * (h + 200 * dpr) - 100 * dpr;
  const band = ctx.createLinearGradient(0, y, 0, y + 100 * dpr);
  band.addColorStop(0, `rgba(${INK}, 0)`);
  band.addColorStop(0.5, `rgba(${INK}, 0.03)`);
  band.addColorStop(1, `rgba(${INK}, 0)`);
  ctx.fillStyle = band;
  ctx.fillRect(0, y, w, 100 * dpr);
}

function drawCrop(t) {
  const { w, h, dpr } = scene;
  const m = 14 * dpr;
  const len = 22 * dpr;
  ctx.strokeStyle = `rgba(${INK}, 0.3)`;
  ctx.lineWidth = 1.4 * dpr;
  ctx.beginPath();
  for (const [x, y, sx, sy] of [[m, m, 1, 1], [w - m, m, -1, 1], [w - m, h - m, -1, -1], [m, h - m, 1, -1]]) {
    ctx.moveTo(x, y + sy * len);
    ctx.lineTo(x, y);
    ctx.lineTo(x + sx * len, y);
  }
  ctx.stroke();
  ctx.font = `${11 * dpr}px monospace`;
  ctx.fillStyle = `rgba(${INK}, 0.35)`;
  ctx.textAlign = 'left';
  ctx.fillText('BEAT \u00b7 BIT', m + 10 * dpr, m + 16 * dpr);
}

function draw(t) {
  ctx.clearRect(0, 0, scene.w, scene.h);
  drawRuled();
  drawRings(t);
  drawColumns(t);
  drawTypewriter(t);
  drawNotes(t);
  drawWords(t);
  drawWash(t);
  drawCrop(t);
}

function resize() {
  if (!canvas) return;
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
  canvas.id = 'bitnik-backdrop';
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

export function initBitnikBackdrop() {
  const root = document.documentElement;
  const sync = () => (root.dataset.colorTheme === THEME ? start() : stop());
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-color-theme'] });
  sync();
}