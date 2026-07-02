// Every texture in the game is painted here at boot — zero downloaded assets.
import * as THREE from 'three';

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

function grain(ctx: CanvasRenderingContext2D, size: number, alpha: number, dark = true): void {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 255 * alpha;
    d[i] += n; d[i + 1] += n; d[i + 2] += dark ? n * 0.8 : n;
  }
  ctx.putImageData(img, 0, 0);
}

function stains(ctx: CanvasRenderingContext2D, size: number, count: number, color: string, maxR: number): void {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * size, y = Math.random() * size, r = 8 + Math.random() * maxR;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
}

function tex(c: HTMLCanvasElement, repeat: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function wallpaperTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512);
  ctx.fillStyle = '#b7a049'; ctx.fillRect(0, 0, 512, 512);
  // faded vertical stripe pattern
  for (let x = 0; x < 512; x += 32) {
    ctx.fillStyle = x % 64 === 0 ? 'rgba(160,135,50,0.35)' : 'rgba(200,180,95,0.25)';
    ctx.fillRect(x, 0, 16, 512);
  }
  stains(ctx, 512, 26, 'rgba(90,70,25,0.14)', 60);
  // water damage creeping from the top
  for (let i = 0; i < 7; i++) {
    const x = Math.random() * 512, w = 20 + Math.random() * 60, h = 60 + Math.random() * 200;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(70,55,20,0.35)'); g.addColorStop(1, 'rgba(70,55,20,0)');
    ctx.fillStyle = g; ctx.fillRect(x, 0, w, h);
  }
  grain(ctx, 512, 0.10);
  return tex(c, 1);
}

export function carpetTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512);
  ctx.fillStyle = '#7d6a30'; ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(60,48,18,0.35)' : 'rgba(140,120,60,0.3)';
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  }
  stains(ctx, 512, 20, 'rgba(35,28,10,0.28)', 90); // the moisture
  grain(ctx, 512, 0.12);
  return tex(c, 8);
}

export function ceilingTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512);
  ctx.fillStyle = '#c9bd8f'; ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = 'rgba(90,80,45,0.7)'; ctx.lineWidth = 3;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath(); ctx.moveTo(i * 128, 0); ctx.lineTo(i * 128, 512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * 128); ctx.lineTo(512, i * 128); ctx.stroke();
  }
  stains(ctx, 512, 14, 'rgba(110,85,30,0.3)', 70);
  grain(ctx, 512, 0.07);
  return tex(c, 8);
}

export function concreteTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512);
  ctx.fillStyle = '#8f8a7c'; ctx.fillRect(0, 0, 512, 512);
  stains(ctx, 512, 30, 'rgba(50,48,40,0.25)', 80);
  ctx.strokeStyle = 'rgba(60,58,50,0.4)'; ctx.lineWidth = 2;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    let x = Math.random() * 512, y = 0;
    ctx.moveTo(x, y);
    while (y < 512) { x += (Math.random() - 0.5) * 40; y += 30 + Math.random() * 50; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  grain(ctx, 512, 0.09);
  return tex(c, 6);
}

export function poolTileTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512);
  ctx.fillStyle = '#9fb8ad'; ctx.fillRect(0, 0, 512, 512);
  const t = 64;
  for (let y = 0; y < 512; y += t) {
    for (let x = 0; x < 512; x += t) {
      ctx.fillStyle = Math.random() < 0.08 ? '#6e8a80' : '#a8c2b6';
      ctx.fillRect(x + 2, y + 2, t - 4, t - 4);
    }
  }
  stains(ctx, 512, 16, 'rgba(60,90,80,0.25)', 60);
  grain(ctx, 512, 0.06, false);
  return tex(c, 8);
}

export function cubicleTex(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256);
  ctx.fillStyle = '#8a8272'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(60,56,46,0.4)' : 'rgba(120,113,96,0.4)';
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 1);
  }
  return tex(c, 2);
}

/** Scrawled writing for landmark walls. */
export function writingTex(lines: string[]): THREE.CanvasTexture {
  const [c, ctx] = canvas(512);
  ctx.fillStyle = '#b7a049'; ctx.fillRect(0, 0, 512, 512);
  stains(ctx, 512, 18, 'rgba(90,70,25,0.2)', 60);
  ctx.fillStyle = 'rgba(40,25,15,0.85)';
  ctx.font = 'bold 46px "Courier New", monospace';
  ctx.textAlign = 'center';
  lines.forEach((l, i) => {
    ctx.save();
    ctx.translate(256 + (Math.random() - 0.5) * 30, 160 + i * 80);
    ctx.rotate((Math.random() - 0.5) * 0.08);
    ctx.fillText(l, 0, 0);
    ctx.restore();
  });
  grain(ctx, 512, 0.08);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const CHALK_SYMBOLS = ['↑', '→', '↓', '←', '✕', '?', '○', '!'] as const;

/** One chalk decal texture per symbol, white on transparent. */
export function chalkTex(sym: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(128);
  ctx.strokeStyle = ctx.fillStyle = 'rgba(240,240,235,0.92)';
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.font = 'bold 90px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // jitter to feel hand-drawn
  ctx.save();
  ctx.translate(64, 64);
  ctx.rotate((Math.random() - 0.5) * 0.1);
  ctx.fillText(CHALK_SYMBOLS[sym] ?? '?', 0, 6);
  ctx.restore();
  // chalk dust
  for (let i = 0; i < 250; i++) {
    ctx.fillStyle = `rgba(240,240,235,${Math.random() * 0.2})`;
    ctx.fillRect(Math.random() * 128, Math.random() * 128, 1.5, 1.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
