// The mental map (hold TAB): a chalk-sketch of everywhere you've been.
// Client-only — each player remembers their own wandering.
import { CELL, wallN, wallW } from '@shared/worldgen';
import type { Avatar } from './avatars';
import { AVATAR_COLORS } from '@shared/protocol';

const PX = 7;         // pixels per cell
const SEE_R = 3;      // cells revealed around you as you walk

export class MentalMap {
  visible = false;
  private visited = new Set<string>();
  private canvas: HTMLCanvasElement;
  /** Direction pulse from almond water: absolute angle to exit + expiry. */
  pulse: { angle: number; until: number } | null = null;
  exitSeen: { x: number; z: number } | null = null;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'mentalmap';
    parent.appendChild(this.canvas);
  }

  reset(): void {
    this.visited.clear();
    this.pulse = null;
    this.exitSeen = null;
  }

  visit(x: number, z: number): void {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let dz = -SEE_R; dz <= SEE_R; dz++) {
      for (let dx = -SEE_R; dx <= SEE_R; dx++) {
        if (dx * dx + dz * dz <= SEE_R * SEE_R) this.visited.add(`${cx + dx},${cz + dz}`);
      }
    }
  }

  draw(seed: number, px: number, pz: number, yaw: number, avatars: Map<string, Avatar>, now: number,
    breakers: { x: number; z: number; collected: boolean }[] = []): void {
    this.canvas.style.display = this.visible ? 'block' : 'none';
    if (!this.visible) return;
    const w = Math.min(innerWidth, innerHeight) * 0.72;
    if (this.canvas.width !== w) { this.canvas.width = this.canvas.height = w; }
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, w);
    ctx.fillStyle = 'rgba(12,10,4,0.88)';
    ctx.fillRect(0, 0, w, w);

    const ccx = Math.floor(px / CELL), ccz = Math.floor(pz / CELL);
    const half = Math.floor(w / PX / 2);
    const toScreen = (cx: number, cz: number): [number, number] =>
      [(cx - ccx + half) * PX, (cz - ccz + half) * PX];

    ctx.strokeStyle = 'rgba(235,230,210,0.75)';
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    for (const key of this.visited) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.abs(cx - ccx) > half || Math.abs(cz - ccz) > half) continue;
      const [sx, sz] = toScreen(cx, cz);
      // faint visited floor
      ctx.fillStyle = 'rgba(200,190,150,0.07)';
      ctx.fillRect(sx, sz, PX, PX);
      if (wallN(seed, cx, cz) > 0) {
        ctx.beginPath(); ctx.moveTo(sx, sz); ctx.lineTo(sx + PX, sz); ctx.stroke();
      }
      if (wallW(seed, cx, cz) > 0) {
        ctx.beginPath(); ctx.moveTo(sx, sz); ctx.lineTo(sx, sz + PX); ctx.stroke();
      }
    }

    // teammates (they told you where they are — radios are magic like that)
    for (const av of avatars.values()) {
      if (!av.alive) continue;
      const [ax, az] = [av.lastState[0] / CELL, av.lastState[2] / CELL];
      if (Math.abs(ax - ccx) > half || Math.abs(az - ccz) > half) continue;
      const [sx, sz] = toScreen(ax, az);
      ctx.fillStyle = '#' + AVATAR_COLORS[av.info.color % AVATAR_COLORS.length].toString(16).padStart(6, '0');
      ctx.beginPath(); ctx.arc(sx, sz, 4, 0, Math.PI * 2); ctx.fill();
    }

    // breaker panels you've been near
    for (const b of breakers) {
      const bcx = Math.floor(b.x / CELL), bcz = Math.floor(b.z / CELL);
      if (!this.visited.has(`${bcx},${bcz}`)) continue;
      if (Math.abs(bcx - ccx) > half || Math.abs(bcz - ccz) > half) continue;
      const [sx, sz] = toScreen(bcx, bcz);
      ctx.strokeStyle = b.collected ? '#4dff88' : '#ffb347';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx - 4, sz - 4, 8, 8);
      if (b.collected) { ctx.beginPath(); ctx.moveTo(sx - 3, sz); ctx.lineTo(sx - 1, sz + 3); ctx.lineTo(sx + 3, sz - 3); ctx.stroke(); }
    }

    // exit, if ever seen
    if (this.exitSeen) {
      const [sx, sz] = toScreen(this.exitSeen.x / CELL, this.exitSeen.z / CELL);
      ctx.strokeStyle = '#bfe8ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx - 5, sz - 5, 10, 10);
    }

    // almond pulse: a chalk ray toward the exit
    if (this.pulse && now < this.pulse.until) {
      ctx.strokeStyle = `rgba(191,232,255,${0.7 * (this.pulse.until - now) / 8})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(w / 2, w / 2);
      ctx.lineTo(w / 2 + Math.cos(this.pulse.angle) * w * 0.4, w / 2 + Math.sin(this.pulse.angle) * w * 0.4);
      ctx.stroke();
    }

    // you
    ctx.save();
    ctx.translate(w / 2 + PX / 2, w / 2 + PX / 2);
    ctx.rotate(-yaw);
    ctx.fillStyle = '#f5edd2';
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(5, 6); ctx.lineTo(-5, 6);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    ctx.fillStyle = 'rgba(235,230,210,0.5)';
    ctx.font = '12px "Courier New", monospace';
    ctx.fillText('what you remember of it', 12, w - 12);
  }
}
