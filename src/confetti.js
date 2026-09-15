// confetti.js — animation canvas de victoire (SPEC §12.4.2).

let canvas = null;
let ctx = null;
let rafId = 0;
let particles = [];
let resizeHandler = null;

/**
 * Palette du THÈME ACTIF, lue une fois au lancement.
 *
 * Les six couleurs étaient celles de VS Code, en dur : des confettis bleu
 * éditeur tombaient sur Paper Quest, sur Girly et sur Matrix. Les jetons
 * d'accent existent déjà pour ça — autant les lire. Une seule lecture de
 * getComputedStyle par lancement, pas une par particule.
 */
function themePalette() {
  const cs = getComputedStyle(document.documentElement);
  const palette = [
    '--color-accent-primary', '--color-accent-cyan', '--color-accent-pink',
    '--color-accent-lime', '--color-warning', '--color-success',
  ].map(t => cs.getPropertyValue(t).trim()).filter(Boolean);
  return palette.length ? palette : ['#007acc'];
}

function randomColor(palette) {
  return palette[Math.floor(Math.random() * palette.length)];
}

/**
 * Lance une animation de confettis. Respecte prefers-reduced-motion.
 * @param {{durationMs?: number, intensity?: number}} opts
 */
export function launchConfetti({ durationMs = 2500, intensity = 120 } = {}) {
  stopConfetti();

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const count = reduced ? Math.min(20, intensity) : intensity;
  const palette = themePalette();

  canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  // z-index 0 et non 9999 : le contenu de l'écran de victoire se place à 1, les
  // confettis tombent donc DERRIÈRE le podium au lieu de le recouvrir.
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:0;';
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d');

  function resize() {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  resizeHandler = resize;
  window.addEventListener('resize', resizeHandler);

  particles = [];
  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * window.innerWidth,
      y: -20 - Math.random() * window.innerHeight * 0.3,
      w: 6 + Math.random() * 8,
      h: 8 + Math.random() * 10,
      color: randomColor(palette),
      vx: (Math.random() - 0.5) * 2.2,
      vy: 2 + Math.random() * 3.5,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.2,
      opacity: 0.8 + Math.random() * 0.2,
    });
  }

  const start = performance.now();
  function frame(now) {
    if (!ctx || !canvas) return;
    const elapsed = now - start;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.vx += (Math.random() - 0.5) * 0.1;
      const alpha = elapsed > durationMs * 0.7
        ? Math.max(0, 1 - (elapsed - durationMs * 0.7) / (durationMs * 0.3))
        : 1;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = p.opacity * alpha;
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }

    if (elapsed < durationMs) {
      rafId = requestAnimationFrame(frame);
    } else {
      stopConfetti();
    }
  }

  // En reduced-motion : particules quasi immobiles, fade rapide.
  if (reduced) {
    for (const p of particles) {
      p.vy = 0.2;
      p.vx = 0;
    }
  }

  rafId = requestAnimationFrame(frame);
}

/**
 * Arrête l'animation et nettoie le canvas.
 */
export function stopConfetti() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }
  if (canvas) {
    canvas.remove();
    canvas = null;
    ctx = null;
  }
  particles = [];
}
