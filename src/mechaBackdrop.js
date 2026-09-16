// mechaBackdrop.js — fond animé du thème Mecha, dessiné dans un <canvas>.
//
// Seule exception à la règle « un thème = theme.css + une entrée de registre »
// (voir AGENTS.md) : une grille en perspective, une skyline de Neo-Tokyo, des
// réticules et des colonnes de données ne se font pas en CSS sans des dizaines
// d'éléments animés.
//
// Le module s'allume et s'éteint tout seul en observant `data-color-theme` :
// themeSwitcher.js n'a pas à le connaître. Hors du thème Mecha, il ne reste ni
// canvas, ni boucle, ni écouteur de redimensionnement.
//
// Garde-fous :
//  - lisibilité : tout est tracé à faible opacité. Des panneaux, mais aussi du
//    texte nu (titre du menu, crédits) passent devant ;
//  - WCAG 2.3.1 : rien ne clignote. Les fenêtres et les voyants varient en
//    fondu, sur des périodes de plusieurs secondes ;
//  - mouvement réduit : une seule image fixe, redessinée au redimensionnement ;
//  - coût : 30 images par seconde au plus, densité de pixels plafonnée, boucle
//    suspendue quand l'onglet est caché.

const THEME = 'mecha';
const FRAME_MS = 1000 / 30;
const GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let canvas = null;
let ctx = null;
let raf = 0;
let last = 0;
let scene = null;

/** Générateur pseudo-aléatoire à graine : la skyline reste la même d'une
 *  image à l'autre et d'un redimensionnement à l'autre. */
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
  const rand = mulberry32(2019); // Neo-Tokyo, 2019
  const horizon = Math.round(h * 0.6);

  const towers = [];
  for (let x = -20 * dpr; x < w; ) {
    const tw = (18 + rand() * 46) * dpr;
    const th = (h * 0.05) + rand() * (h * 0.2);
    const lights = [];
    const cols = Math.max(1, Math.floor(tw / (7 * dpr)));
    const rows = Math.max(1, Math.floor(th / (9 * dpr)));
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        if (rand() < 0.16) {
          lights.push({
            x: x + 3 * dpr + c * 7 * dpr,
            y: horizon - th + 4 * dpr + r * 9 * dpr,
            amber: rand() < 0.7,
            phase: rand() * Math.PI * 2,
            period: 3 + rand() * 6,
          });
        }
      }
    }
    towers.push({ x, w: tw, h: th, lights });
    x += tw + (2 + rand() * 10) * dpr;
  }

  const reticles = Array.from({ length: 3 }, (_, i) => ({
    r: (34 + rand() * 30) * dpr,
    ax: 0.15 + rand() * 0.7,
    ay: 0.12 + rand() * 0.3,
    speed: 0.02 + rand() * 0.03,
    phase: rand() * Math.PI * 2,
    amber: i === 1,
  }));

  const columns = [0.04, 0.965, 0.9].map((fx) => ({
    x: fx * w,
    offset: rand() * h,
    speed: (38 + rand() * 30) * dpr,
    seed: Math.floor(rand() * 1000),
  }));

  return { w, h, dpr, horizon, towers, reticles, columns };
}

function drawGrid(t) {
  const { w, h, dpr, horizon } = scene;
  const vx = w / 2;
  ctx.lineWidth = dpr;

  // Lignes fuyantes vers le point de fuite
  ctx.strokeStyle = 'rgba(63, 220, 255, 0.10)';
  ctx.beginPath();
  for (let i = -24; i <= 24; i++) {
    ctx.moveTo(vx, horizon);
    ctx.lineTo(vx + i * (w / 10), h);
  }
  ctx.stroke();

  // Traverses qui avancent vers le spectateur
  const phase = (t * 0.35) % 1;
  for (let j = 0; j < 22; j++) {
    const d = j + 1 - phase;
    const k = 1 / (1 + d * 0.45);
    const y = horizon + (h - horizon) * k;
    ctx.strokeStyle = `rgba(63, 220, 255, ${(0.02 + 0.11 * k).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Ligne d'horizon et son halo
  const glow = ctx.createLinearGradient(0, horizon - 40 * dpr, 0, horizon + 40 * dpr);
  glow.addColorStop(0, 'rgba(255, 162, 46, 0)');
  glow.addColorStop(0.5, 'rgba(255, 162, 46, 0.07)');
  glow.addColorStop(1, 'rgba(255, 162, 46, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, horizon - 40 * dpr, w, 80 * dpr);
  ctx.fillStyle = 'rgba(255, 162, 46, 0.22)';
  ctx.fillRect(0, horizon, w, dpr);
}

function drawSkyline(t) {
  const { horizon, dpr } = scene;
  for (const tower of scene.towers) {
    ctx.fillStyle = '#0c131a';
    ctx.fillRect(tower.x, horizon - tower.h, tower.w, tower.h);
    ctx.fillStyle = 'rgba(63, 220, 255, 0.10)';
    ctx.fillRect(tower.x, horizon - tower.h, tower.w, dpr);
    for (const l of tower.lights) {
      // Fondu lent : une fenêtre met plusieurs secondes à s'allumer
      const a = 0.08 + 0.2 * (0.5 + 0.5 * Math.sin(t * (Math.PI * 2 / l.period) + l.phase));
      ctx.fillStyle = l.amber ? `rgba(255, 162, 46, ${a.toFixed(3)})` : `rgba(63, 220, 255, ${a.toFixed(3)})`;
      ctx.fillRect(l.x, l.y, 2 * dpr, 2 * dpr);
    }
  }
}

function drawReticles(t) {
  const { w, h, dpr } = scene;
  for (const r of scene.reticles) {
    const x = w * (r.ax + 0.05 * Math.sin(t * r.speed * 6 + r.phase));
    const y = h * (r.ay + 0.04 * Math.cos(t * r.speed * 5 + r.phase));
    const rot = t * r.speed * 4 + r.phase;
    ctx.strokeStyle = r.amber ? 'rgba(255, 162, 46, 0.16)' : 'rgba(63, 220, 255, 0.14)';
    ctx.lineWidth = dpr;

    ctx.beginPath();
    ctx.arc(x, y, r.r, 0, Math.PI * 2);
    ctx.stroke();

    // Arc intérieur en pointillés, qui tourne
    ctx.setLineDash([6 * dpr, 5 * dpr]);
    ctx.beginPath();
    ctx.arc(x, y, r.r * 0.7, rot, rot + Math.PI * 1.4);
    ctx.stroke();
    ctx.setLineDash([]);

    // Quatre graduations et une croix centrale
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const a = rot * 0.5 + k * Math.PI / 2;
      ctx.moveTo(x + Math.cos(a) * r.r * 0.85, y + Math.sin(a) * r.r * 0.85);
      ctx.lineTo(x + Math.cos(a) * r.r * 1.15, y + Math.sin(a) * r.r * 1.15);
    }
    ctx.moveTo(x - 5 * dpr, y);
    ctx.lineTo(x + 5 * dpr, y);
    ctx.moveTo(x, y - 5 * dpr);
    ctx.lineTo(x, y + 5 * dpr);
    ctx.stroke();
  }
}

function drawColumns(t) {
  const { h, dpr } = scene;
  const size = 12 * dpr;
  ctx.font = `${size}px monospace`;
  ctx.textAlign = 'center';
  for (const col of scene.columns) {
    const head = (col.offset + t * col.speed) % (h + 16 * size);
    const tick = Math.floor(t * 1.25); // un glyphe change toutes les 0,8 s
    for (let k = 0; k < 14; k++) {
      const y = head - k * size * 1.2;
      if (y < -size || y > h) continue;
      const a = k === 0 ? 0.38 : 0.2 * (1 - k / 14);
      const g = GLYPHS[(col.seed + k * 7 + tick * (k % 3 === 0 ? 1 : 0)) % GLYPHS.length];
      ctx.fillStyle = `rgba(61, 255, 138, ${a.toFixed(3)})`;
      ctx.fillText(g, col.x, y);
    }
  }
}

function drawScan(t) {
  const { w, h, dpr } = scene;
  const y = ((t / 9) % 1) * (h + 160 * dpr) - 80 * dpr;
  const band = ctx.createLinearGradient(0, y, 0, y + 80 * dpr);
  band.addColorStop(0, 'rgba(63, 220, 255, 0)');
  band.addColorStop(0.5, 'rgba(63, 220, 255, 0.045)');
  band.addColorStop(1, 'rgba(63, 220, 255, 0)');
  ctx.fillStyle = band;
  ctx.fillRect(0, y, w, 80 * dpr);
}

function drawHud() {
  const { w, h, dpr } = scene;
  const m = 14 * dpr;
  const len = 26 * dpr;
  ctx.strokeStyle = 'rgba(255, 162, 46, 0.3)';
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  for (const [x, y, sx, sy] of [[m, m, 1, 1], [w - m, m, -1, 1], [w - m, h - m, -1, -1], [m, h - m, 1, -1]]) {
    ctx.moveTo(x, y + sy * len);
    ctx.lineTo(x, y);
    ctx.lineTo(x + sx * len, y);
  }
  ctx.stroke();
  ctx.font = `${10 * dpr}px monospace`;
  ctx.fillStyle = 'rgba(143, 163, 181, 0.35)';
  ctx.textAlign = 'left';
  ctx.fillText('NEO-TOKYO // SYS ONLINE', m + 8 * dpr, m + 18 * dpr);
  ctx.textAlign = 'right';
  ctx.fillText('MS-CQZ // LINK OK', w - m - 8 * dpr, m + 18 * dpr);
}

function draw(t) {
  ctx.clearRect(0, 0, scene.w, scene.h);
  drawReticles(t);
  drawColumns(t);
  drawSkyline(t);
  drawGrid(t);
  drawScan(t);
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
  canvas.id = 'mecha-backdrop';
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

export function initMechaBackdrop() {
  const root = document.documentElement;
  const sync = () => (root.dataset.colorTheme === THEME ? start() : stop());
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-color-theme'] });
  sync();
}
