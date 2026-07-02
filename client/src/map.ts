// The mental map (hold TAB), v2: a chalk-sketch of everywhere you've been,
// with zoom, your crew's chalk marks, landmarks you've found, where people
// died, and edge arrows toward discovered objectives. Client-only — each
// player remembers their own wandering.
import { BLOCK, CELL, blockArchetype, blockDark, wallN, wallW } from '@shared/worldgen';
import type { Avatar } from './avatars';
import type { Mark } from '@shared/protocol';
import { AVATAR_COLORS, } from '@shared/protocol';
import { CHALK_SYMBOLS } from './textures';

const SEE_R = 3;
const ZOOMS = [4.5, 7, 11];

export interface POI { x: number; z: number; kind: string }

const POI_GLYPH: Record<string, string> = {
  vending: 'V', door: 'D', shrine: 'S', writing: 'W', chair: 'C', cabinets: 'F',
};

export class MentalMap {
  visible = false;
  private visited = new Map<string, number>(); // cell -> archetype code
  private canvas: HTMLCanvasElement;
  private zoom = 1;
  pulse: { angle: number; until: number } | null = null;
  exitSeen: { x: number; z: number } | null = null;
  pois: POI[] = [];
  deaths: { x: number; z: number }[] = [];
  knownBreakers = new Set<string>(); // crew intel: marked for everyone

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'mentalmap';
    parent.appendChild(this.canvas);
    addEventListener('wheel', (e) => {
      if (!this.visible) return;
      this.zoom = Math.max(0, Math.min(ZOOMS.length - 1, this.zoom + (e.deltaY < 0 ? 1 : -1)));
    });
  }

  reset(): void {
    this.visited.clear();
    this.pulse = null;
    this.exitSeen = null;
    this.pois = [];
    this.deaths = [];
    this.knownBreakers.clear();
  }

  addPOI(x: number, z: number, kind: string): void {
    if (this.pois.some((p) => Math.abs(p.x - x) < 2 && Math.abs(p.z - z) < 2)) return;
    this.pois.push({ x, z, kind });
  }

  addDeath(x: number, z: number): void { this.deaths.push({ x, z }); }

  visit(seed: number, x: number, z: number): void {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let dz = -SEE_R; dz <= SEE_R; dz++) {
      for (let dx = -SEE_R; dx <= SEE_R; dx++) {
        if (dx * dx + dz * dz > SEE_R * SEE_R) continue;
        const key = `${cx + dx},${cz + dz}`;
        if (this.visited.has(key)) continue;
        const bx = Math.floor((cx + dx) / BLOCK), bz = Math.floor((cz + dz) / BLOCK);
        const a = blockArchetype(seed, bx, bz);
        const code = a === 'pool' ? 1 : a === 'landmark' ? 2 : blockDark(seed, bx, bz) ? 3 : 0;
        this.visited.set(key, code);
      }
    }
  }

  draw(seed: number, px: number, pz: number, yaw: number, avatars: Map<string, Avatar>, now: number,
    breakers: { id?: string; x: number; z: number; collected: boolean }[] = [], marks: Mark[] = [],
    entity: { x: number; z: number } | null = null): void {
    this.canvas.style.display = this.visible ? 'block' : 'none';
    if (!this.visible) return;
    const PX = ZOOMS[this.zoom];
    const w = Math.min(innerWidth, innerHeight) * 0.72;
    if (this.canvas.width !== Math.round(w)) { this.canvas.width = this.canvas.height = Math.round(w); }
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, w);
    ctx.fillStyle = 'rgba(12,10,4,0.9)';
    ctx.fillRect(0, 0, w, w);

    const ccx = Math.floor(px / CELL), ccz = Math.floor(pz / CELL);
    const half = Math.floor(w / PX / 2);
    const toScreen = (cx: number, cz: number): [number, number] =>
      [(cx - ccx + half) * PX, (cz - ccz + half) * PX];

    // visited floor tinted by what kind of place it was
    const tints = ['rgba(200,190,150,0.08)', 'rgba(120,200,190,0.13)', 'rgba(190,190,200,0.13)', 'rgba(60,50,30,0.25)'];
    for (const [key, code] of this.visited) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.abs(cx - ccx) > half || Math.abs(cz - ccz) > half) continue;
      const [sx, sz] = toScreen(cx, cz);
      ctx.fillStyle = tints[code];
      ctx.fillRect(sx, sz, PX, PX);
    }
    // walls
    ctx.strokeStyle = 'rgba(235,230,210,0.8)';
    ctx.lineWidth = Math.max(1.2, PX * 0.2);
    ctx.lineCap = 'round';
    for (const key of this.visited.keys()) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.abs(cx - ccx) > half || Math.abs(cz - ccz) > half) continue;
      const [sx, sz] = toScreen(cx, cz);
      if (wallN(seed, cx, cz) > 0) { ctx.beginPath(); ctx.moveTo(sx, sz); ctx.lineTo(sx + PX, sz); ctx.stroke(); }
      if (wallW(seed, cx, cz) > 0) { ctx.beginPath(); ctx.moveTo(sx, sz); ctx.lineTo(sx, sz + PX); ctx.stroke(); }
    }

    // chalk marks — yours and theirs
    ctx.font = `${Math.max(9, PX * 1.5)}px "Courier New", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const m of marks) {
      const mcx = m.x / CELL, mcz = m.z / CELL;
      if (Math.abs(mcx - ccx) > half || Math.abs(mcz - ccz) > half) continue;
      if (!this.visited.has(`${Math.floor(mcx)},${Math.floor(mcz)}`)) continue;
      const [sx, sz] = toScreen(mcx, mcz);
      ctx.fillStyle = 'rgba(240,240,235,0.85)';
      ctx.fillText(CHALK_SYMBOLS[m.sym % CHALK_SYMBOLS.length], sx, sz);
    }

    // landmarks you've stood near
    for (const p of this.pois) {
      const pcx = p.x / CELL, pcz = p.z / CELL;
      if (Math.abs(pcx - ccx) > half || Math.abs(pcz - ccz) > half) continue;
      const [sx, sz] = toScreen(pcx, pcz);
      ctx.fillStyle = 'rgba(201,180,90,0.9)';
      ctx.fillText(POI_GLYPH[p.kind] ?? '·', sx, sz);
    }

    // breaker panels — shown once anyone on the crew has found them
    for (const b of breakers) {
      const bcx = b.x / CELL, bcz = b.z / CELL;
      const known = (b.id && this.knownBreakers.has(b.id)) ||
        this.visited.has(`${Math.floor(bcx)},${Math.floor(bcz)}`);
      if (!known) continue;
      if (Math.abs(bcx - ccx) > half || Math.abs(bcz - ccz) > half) {
        this.edgeArrow(ctx, w, px, pz, b.x, b.z, b.collected ? '#4dff88' : '#ffb347');
        continue;
      }
      const [sx, sz] = toScreen(bcx, bcz);
      ctx.strokeStyle = b.collected ? '#4dff88' : '#ffb347';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx - 5, sz - 5, 10, 10);
      if (b.collected) { ctx.beginPath(); ctx.moveTo(sx - 3, sz); ctx.lineTo(sx - 1, sz + 3); ctx.lineTo(sx + 3, sz - 3); ctx.stroke(); }
    }

    // the exit, once seen
    if (this.exitSeen) {
      const ecx = this.exitSeen.x / CELL, ecz = this.exitSeen.z / CELL;
      if (Math.abs(ecx - ccx) > half || Math.abs(ecz - ccz) > half) {
        this.edgeArrow(ctx, w, px, pz, this.exitSeen.x, this.exitSeen.z, '#bfe8ff');
      } else {
        const [sx, sz] = toScreen(ecx, ecz);
        ctx.strokeStyle = '#bfe8ff';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(sx - 6, sz - 6, 12, 12);
        ctx.strokeRect(sx - 2, sz - 2, 4, 4);
      }
    }

    // where people were lost
    ctx.fillStyle = 'rgba(163,59,46,0.95)';
    for (const d of this.deaths) {
      const dcx = d.x / CELL, dcz = d.z / CELL;
      if (Math.abs(dcx - ccx) > half || Math.abs(dcz - ccz) > half) continue;
      const [sx, sz] = toScreen(dcx, dcz);
      ctx.fillText('✕', sx, sz);
    }

    // teammates (the radios are magic)
    for (const av of avatars.values()) {
      if (!av.alive) continue;
      const [ax, az] = [av.lastState[0] / CELL, av.lastState[2] / CELL];
      const col = '#' + AVATAR_COLORS[av.info.color % AVATAR_COLORS.length].toString(16).padStart(6, '0');
      if (Math.abs(ax - ccx) > half || Math.abs(az - ccz) > half) {
        this.edgeArrow(ctx, w, px, pz, av.lastState[0], av.lastState[2], col);
        continue;
      }
      const [sx, sz] = toScreen(ax, az);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(sx, sz, 4.5, 0, Math.PI * 2); ctx.fill();
      if (av.lastState[5] === 4) { // downed: pulse
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx, sz, 7 + Math.sin(now * 6) * 2.5, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // the dead see it. it's only fair.
    if (entity) {
      const ecx = entity.x / CELL, ecz = entity.z / CELL;
      if (Math.abs(ecx - ccx) <= half && Math.abs(ecz - ccz) <= half) {
        const [sx, sz] = toScreen(ecx, ecz);
        ctx.fillStyle = '#ff2a1a';
        ctx.beginPath(); ctx.arc(sx, sz, 5 + Math.sin(now * 8) * 1.5, 0, Math.PI * 2); ctx.fill();
      } else {
        this.edgeArrow(ctx, w, px, pz, entity.x, entity.z, '#ff2a1a');
      }
    }

    // almond pulse: a chalk ray toward the current objective
    if (this.pulse && now < this.pulse.until) {
      ctx.strokeStyle = `rgba(191,232,255,${0.7 * (this.pulse.until - now) / 8})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(w / 2, w / 2);
      ctx.lineTo(w / 2 + Math.cos(this.pulse.angle) * w * 0.4, w / 2 + Math.sin(this.pulse.angle) * w * 0.4);
      ctx.stroke();
    }

    // you + facing cone
    ctx.save();
    ctx.translate(w / 2 + PX / 2, w / 2 + PX / 2);
    ctx.rotate(-yaw);
    ctx.fillStyle = 'rgba(245,237,210,0.12)';
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.arc(0, 0, PX * 6, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#f5edd2';
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(5, 6); ctx.lineTo(-5, 6);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    ctx.fillStyle = 'rgba(235,230,210,0.5)';
    ctx.font = '12px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('what you remember of it · scroll to zoom', 12, w - 12);
  }

  private edgeArrow(ctx: CanvasRenderingContext2D, w: number, px: number, pz: number, tx: number, tz: number, color: string): void {
    const a = Math.atan2(tz - pz, tx - px);
    const r = w / 2 - 16;
    const x = w / 2 + Math.cos(a) * r, z = w / 2 + Math.sin(a) * r;
    ctx.save();
    ctx.translate(x, z);
    ctx.rotate(a);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(8, 0); ctx.lineTo(-4, -5); ctx.lineTo(-4, 5);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}
